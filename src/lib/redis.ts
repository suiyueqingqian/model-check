import Redis from "ioredis";
import { EventEmitter } from "events";
import { createAsyncErrorHandler } from "@/lib/utils/error";

const globalForRedis = globalThis as unknown as {
  redis: Redis | undefined;
  pubsubSubscriber: Redis | undefined;
  pubsubEmitter: EventEmitter | undefined;
  pubsubConnected: boolean | undefined;
  pubsubChannels: Set<string> | undefined;
};

function attachErrorHandler(client: Redis) {
  client.on("error", (err) => {
    if ((err as NodeJS.ErrnoException).code === "ECONNREFUSED") {
      console.error("[Redis] 连接被拒绝:", err.message);
    } else {
      console.error("[Redis] 错误:", err.message);
    }
  });
}

function createRedisClient() {
  const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
  const client = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: false,
    retryStrategy(times) {
      return Math.min(times * 500, 30000);
    },
  });

  attachErrorHandler(client);
  client.on("connect", () => {
  });

  // 覆盖 duplicate，让复制出的连接也带 error 监听
  const originalDuplicate = client.duplicate.bind(client);
  client.duplicate = (...args: Parameters<typeof client.duplicate>) => {
    const dup = originalDuplicate(...args);
    attachErrorHandler(dup);
    return dup;
  };

  return client;
}

export function getRedisClient(): Redis {
  if (!globalForRedis.redis) {
    globalForRedis.redis = createRedisClient();
  }
  return globalForRedis.redis;
}

/**
 * Shared Pub/Sub infrastructure to avoid creating new Redis connections per SSE request.
 * Uses a single subscriber connection and EventEmitter to broadcast messages to all listeners.
 */
export interface PubSubManager {
  subscribe(channel: string, callback: (message: string) => void): () => void;
  isConnected(): boolean;
}

function createPubSubManager(): PubSubManager {
  const emitter = globalForRedis.pubsubEmitter ?? new EventEmitter();
  emitter.setMaxListeners(1000); // Allow many SSE clients

  // Use global state to persist across hot reloads
  const subscribedChannels = globalForRedis.pubsubChannels ?? new Set<string>();
  let subscriber: Redis | null = globalForRedis.pubsubSubscriber ?? null;
  let isSubscriberConnected = globalForRedis.pubsubConnected ?? false;
  let subscriberPromise: Promise<Redis> | null = null;
  const handleReconnectError = createAsyncErrorHandler("[Redis] 订阅连接重连失败", "warn");
  const handleSubscribeError = createAsyncErrorHandler("[Redis] 订阅频道失败", "warn");
  const handleEnsureSubscriberError = createAsyncErrorHandler("[Redis] 初始化订阅连接失败", "warn");
  const handleUnsubscribeError = createAsyncErrorHandler("[Redis] 取消订阅频道失败", "warn");

  // Store in global immediately
  globalForRedis.pubsubEmitter = emitter;
  globalForRedis.pubsubChannels = subscribedChannels;

  const ensureSubscriber = async (): Promise<Redis> => {
    // Return existing connected subscriber
    if (subscriber && isSubscriberConnected) {
      return subscriber;
    }

    // Return pending connection promise to avoid duplicate connections
    if (subscriberPromise) return subscriberPromise;

    subscriberPromise = (async () => {
      const redisUrl = process.env.REDIS_URL || "redis://localhost:6379";
      const newSubscriber = new Redis(redisUrl, {
        maxRetriesPerRequest: null,
        enableReadyCheck: false,
        lazyConnect: true,
      });

      attachErrorHandler(newSubscriber);

      newSubscriber.on("message", (channel, message) => {
        emitter.emit(`message:${channel}`, message);
      });

      newSubscriber.on("connect", () => {
        isSubscriberConnected = true;
        globalForRedis.pubsubConnected = true;
      });

      newSubscriber.on("close", () => {
        isSubscriberConnected = false;
        globalForRedis.pubsubConnected = false;
        subscriberPromise = null; // Allow reconnection
        // 延迟触发重连
        setTimeout(() => {
          if (!isSubscriberConnected && !subscriberPromise) {
            ensureSubscriber().catch(handleReconnectError);
          }
        }, 3000);
      });

      newSubscriber.on("error", () => {
        subscriberPromise = null; // Allow retry on error
      });

      await newSubscriber.connect();
      subscriber = newSubscriber;

      // Store in global for singleton pattern
      globalForRedis.pubsubSubscriber = subscriber;

      // Re-subscribe to all channels after reconnection
      for (const ch of subscribedChannels) {
        await subscriber.subscribe(ch);
      }

      return subscriber;
    })();

    return subscriberPromise;
  };

  return {
    subscribe(channel: string, callback: (message: string) => void): () => void {
      const eventName = `message:${channel}`;

      // Add listener immediately (messages will be buffered by EventEmitter)
      emitter.on(eventName, callback);

      // Track channel for re-subscription on reconnect
      const wasNew = !subscribedChannels.has(channel);
      subscribedChannels.add(channel);

      // Subscribe to Redis channel
      ensureSubscriber().then((sub) => {
        if (wasNew) {
          sub.subscribe(channel)
            .catch(handleSubscribeError);
        }
      }).catch(handleEnsureSubscriberError);

      // Return unsubscribe function
      return () => {
        emitter.off(eventName, callback);
        // 无监听器时取消 Redis 订阅，防止频道泄露
        if (emitter.listenerCount(eventName) === 0) {
          subscribedChannels.delete(channel);
          if (subscriber && isSubscriberConnected) {
            subscriber.unsubscribe(channel).catch(handleUnsubscribeError);
          }
        }
      };
    },

    isConnected(): boolean {
      return isSubscriberConnected;
    },
  };
}

export const pubsubManager = createPubSubManager();

export default getRedisClient;
