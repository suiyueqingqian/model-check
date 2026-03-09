-- Model Check - PostgreSQL 数据库初始化 & 增量迁移脚本
-- 完全幂等：无论数据库处于哪个历史版本，重复执行均安全
--
-- 用法（二选一）:
--   1. Docker 本地:  docker compose exec -T postgres psql -U modelcheck -d model_check < prisma/init.postgresql.sql
--   2. 云数据库:     psql "$DATABASE_URL" < prisma/init.postgresql.sql
--   3. deploy.sh:    ./deploy.sh --update（自动执行）

-- ==========================================
-- 1. 枚举类型
-- ==========================================

-- 创建 EndpointType（首次安装）
DO $$ BEGIN
    CREATE TYPE "EndpointType" AS ENUM ('CHAT', 'CLAUDE', 'GEMINI', 'CODEX', 'IMAGE');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- 兼容升级：补齐后续迭代新增的枚举值
DO $$ BEGIN ALTER TYPE "EndpointType" ADD VALUE IF NOT EXISTS 'CODEX'; EXCEPTION WHEN others THEN NULL; END $$;
DO $$ BEGIN ALTER TYPE "EndpointType" ADD VALUE IF NOT EXISTS 'IMAGE'; EXCEPTION WHEN others THEN NULL; END $$;

-- 创建 CheckStatus（首次安装）
DO $$ BEGIN
    CREATE TYPE "CheckStatus" AS ENUM ('SUCCESS', 'FAIL');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

-- ==========================================
-- 2. 建表（首次安装时生效）
-- ==========================================

CREATE TABLE IF NOT EXISTS "channels" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "base_url" VARCHAR(500) NOT NULL,
  "api_key" TEXT NOT NULL,
  "proxy" VARCHAR(500),
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "key_mode" TEXT NOT NULL DEFAULT 'single',
  "route_strategy" TEXT NOT NULL DEFAULT 'round_robin',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "channel_keys" (
  "id" TEXT NOT NULL,
  "channel_id" TEXT NOT NULL,
  "api_key" TEXT NOT NULL,
  "name" VARCHAR(100),
  "last_valid" BOOLEAN,
  "last_checked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "channel_keys_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "models" (
  "id" TEXT NOT NULL,
  "channel_id" TEXT NOT NULL,
  "model_name" VARCHAR(200) NOT NULL,
  "detected_endpoints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "preferred_proxy_endpoint" VARCHAR(20),
  "last_status" BOOLEAN,
  "last_latency" INTEGER,
  "last_checked_at" TIMESTAMP(3),
  "channel_key_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "models_channel_id_model_name_channel_key_id_key" UNIQUE NULLS NOT DISTINCT ("channel_id", "model_name", "channel_key_id"),
  CONSTRAINT "models_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "models_channel_key_id_fkey" FOREIGN KEY ("channel_key_id") REFERENCES "channel_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "check_logs" (
  "id" TEXT NOT NULL,
  "model_id" TEXT NOT NULL,
  "endpoint_type" "EndpointType" NOT NULL,
  "status" "CheckStatus" NOT NULL,
  "latency" INTEGER,
  "status_code" INTEGER,
  "error_msg" TEXT,
  "response_content" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "check_logs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE TABLE IF NOT EXISTS "scheduler_config" (
  "id" TEXT NOT NULL DEFAULT 'default',
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "cron_schedule" VARCHAR(100) NOT NULL DEFAULT '0 0,8,12,16,20 * * *',
  "timezone" VARCHAR(50) NOT NULL DEFAULT 'Asia/Shanghai',
  "channel_concurrency" INTEGER NOT NULL DEFAULT 5,
  "max_global_concurrency" INTEGER NOT NULL DEFAULT 30,
  "min_delay_ms" INTEGER NOT NULL DEFAULT 3000,
  "max_delay_ms" INTEGER NOT NULL DEFAULT 5000,
  "detect_all_channels" BOOLEAN NOT NULL DEFAULT true,
  "selected_channel_ids" JSONB,
  "selected_model_ids" JSONB,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "proxy_keys" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "key" VARCHAR(100) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "allow_all_models" BOOLEAN NOT NULL DEFAULT true,
  "allowed_channel_ids" JSONB,
  "allowed_model_ids" JSONB,
  "unified_mode" BOOLEAN NOT NULL DEFAULT false,
  "allowed_unified_models" JSONB,
  "last_used_at" TIMESTAMP(3),
  "usage_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "proxy_keys_key_key" UNIQUE ("key")
);

CREATE TABLE IF NOT EXISTS "model_keywords" (
  "id" TEXT NOT NULL,
  "keyword" VARCHAR(100) NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "proxy_request_logs" (
  "id" TEXT NOT NULL,
  "proxy_key_id" TEXT,
  "channel_id" TEXT,
  "model_id" TEXT,
  "request_path" VARCHAR(200) NOT NULL,
  "request_method" VARCHAR(10) NOT NULL,
  "endpoint_type" "EndpointType",
  "requested_model" VARCHAR(200),
  "actual_model_name" VARCHAR(200),
  "channel_name" VARCHAR(100),
  "proxy_key_name" VARCHAR(100),
  "is_stream" BOOLEAN NOT NULL DEFAULT false,
  "success" BOOLEAN NOT NULL,
  "status_code" INTEGER,
  "latency" INTEGER,
  "error_msg" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "proxy_request_logs_proxy_key_id_fkey" FOREIGN KEY ("proxy_key_id") REFERENCES "proxy_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "proxy_request_logs_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "proxy_request_logs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- ==========================================
-- 3. 兼容升级：逐字段补齐（已存在则跳过）
-- ==========================================

-- channels: 后加的排序字段
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "proxy" VARCHAR(500);
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "key_mode" TEXT NOT NULL DEFAULT 'single';
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "route_strategy" TEXT NOT NULL DEFAULT 'round_robin';

-- channel_keys: 多 Key 字段
ALTER TABLE "channel_keys" ADD COLUMN IF NOT EXISTS "name" VARCHAR(100);
ALTER TABLE "channel_keys" ADD COLUMN IF NOT EXISTS "last_valid" BOOLEAN;
ALTER TABLE "channel_keys" ADD COLUMN IF NOT EXISTS "last_checked_at" TIMESTAMP(3);
ALTER TABLE "channel_keys" ADD COLUMN IF NOT EXISTS "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;
ALTER TABLE "channel_keys" ADD COLUMN IF NOT EXISTS "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

-- models: 后加的检测端点、状态字段
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "detected_endpoints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "preferred_proxy_endpoint" VARCHAR(20);
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "last_status" BOOLEAN;
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "last_latency" INTEGER;
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "last_checked_at" TIMESTAMP(3);
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "channel_key_id" TEXT;

-- check_logs: 后加的状态码、响应内容字段
ALTER TABLE "check_logs" ADD COLUMN IF NOT EXISTS "latency" INTEGER;
ALTER TABLE "check_logs" ADD COLUMN IF NOT EXISTS "status_code" INTEGER;
ALTER TABLE "check_logs" ADD COLUMN IF NOT EXISTS "error_msg" TEXT;
ALTER TABLE "check_logs" ADD COLUMN IF NOT EXISTS "response_content" TEXT;

-- scheduler_config: 后加的检测范围控制字段
ALTER TABLE "scheduler_config" ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(50) NOT NULL DEFAULT 'Asia/Shanghai';
ALTER TABLE "scheduler_config" ADD COLUMN IF NOT EXISTS "channel_concurrency" INTEGER NOT NULL DEFAULT 5;
ALTER TABLE "scheduler_config" ADD COLUMN IF NOT EXISTS "max_global_concurrency" INTEGER NOT NULL DEFAULT 30;
ALTER TABLE "scheduler_config" ADD COLUMN IF NOT EXISTS "min_delay_ms" INTEGER NOT NULL DEFAULT 3000;
ALTER TABLE "scheduler_config" ADD COLUMN IF NOT EXISTS "max_delay_ms" INTEGER NOT NULL DEFAULT 5000;
ALTER TABLE "scheduler_config" ADD COLUMN IF NOT EXISTS "detect_all_channels" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "scheduler_config" ADD COLUMN IF NOT EXISTS "selected_channel_ids" JSONB;
ALTER TABLE "scheduler_config" ADD COLUMN IF NOT EXISTS "selected_model_ids" JSONB;

-- proxy_keys: 后加的权限控制字段
ALTER TABLE "proxy_keys" ADD COLUMN IF NOT EXISTS "allow_all_models" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "proxy_keys" ADD COLUMN IF NOT EXISTS "allowed_channel_ids" JSONB;
ALTER TABLE "proxy_keys" ADD COLUMN IF NOT EXISTS "allowed_model_ids" JSONB;
ALTER TABLE "proxy_keys" ADD COLUMN IF NOT EXISTS "last_used_at" TIMESTAMP(3);
ALTER TABLE "proxy_keys" ADD COLUMN IF NOT EXISTS "usage_count" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "proxy_keys" ADD COLUMN IF NOT EXISTS "unified_mode" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "proxy_keys" ADD COLUMN IF NOT EXISTS "allowed_unified_models" JSONB;

-- proxy_request_logs: 后加的字段
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "proxy_key_id" TEXT;
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "channel_id" TEXT;
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "model_id" TEXT;
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "endpoint_type" "EndpointType";
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "requested_model" VARCHAR(200);
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "actual_model_name" VARCHAR(200);
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "channel_name" VARCHAR(100);
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "proxy_key_name" VARCHAR(100);
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "is_stream" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "status_code" INTEGER;
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "latency" INTEGER;
ALTER TABLE "proxy_request_logs" ADD COLUMN IF NOT EXISTS "error_msg" TEXT;

-- 默认内置代理 key 初始化
-- 从 app.proxy_api_key 读取；为空时跳过
WITH builtin_proxy_key AS (
  SELECT NULLIF(current_setting('app.proxy_api_key', true), '') AS key_value
)
INSERT INTO "proxy_keys" (
  "id",
  "name",
  "key",
  "enabled",
  "allow_all_models",
  "allowed_channel_ids",
  "allowed_model_ids",
  "unified_mode",
  "allowed_unified_models",
  "usage_count",
  "created_at",
  "updated_at"
)
SELECT
  '__builtin_proxy_key__',
  '内置代理密钥',
  builtin_proxy_key.key_value,
  true,
  true,
  NULL,
  NULL,
  true,
  NULL,
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM builtin_proxy_key
WHERE builtin_proxy_key.key_value IS NOT NULL
ON CONFLICT ("id") DO UPDATE SET
  "key" = EXCLUDED."key",
  "updated_at" = CURRENT_TIMESTAMP;

-- ==========================================
-- 4. 约束兼容（已存在则跳过）
-- ==========================================

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'channel_keys_channel_id_fkey'
  ) THEN
    ALTER TABLE "channel_keys"
      ADD CONSTRAINT "channel_keys_channel_id_fkey"
      FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'models_channel_key_id_fkey'
  ) THEN
    ALTER TABLE "models"
      ADD CONSTRAINT "models_channel_key_id_fkey"
      FOREIGN KEY ("channel_key_id") REFERENCES "channel_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'models_channel_id_fkey'
  ) THEN
    ALTER TABLE "models"
      ADD CONSTRAINT "models_channel_id_fkey"
      FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'check_logs_model_id_fkey'
  ) THEN
    ALTER TABLE "check_logs"
      ADD CONSTRAINT "check_logs_model_id_fkey"
      FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'models_channel_id_model_name_key'
  ) THEN
    ALTER TABLE "models" DROP CONSTRAINT "models_channel_id_model_name_key";
  END IF;
END $$;

-- DROP + ADD 在同一个 DO 块中执行，PL/pgSQL DO 块具有隐式事务保护，确保原子性
DO $$ BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'models_channel_id_model_name_channel_key_id_key'
  ) THEN
    ALTER TABLE "models" DROP CONSTRAINT "models_channel_id_model_name_channel_key_id_key";
  END IF;
  ALTER TABLE "models"
    ADD CONSTRAINT "models_channel_id_model_name_channel_key_id_key"
    UNIQUE NULLS NOT DISTINCT ("channel_id", "model_name", "channel_key_id");
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proxy_request_logs_proxy_key_id_fkey'
  ) THEN
    ALTER TABLE "proxy_request_logs"
      ADD CONSTRAINT "proxy_request_logs_proxy_key_id_fkey"
      FOREIGN KEY ("proxy_key_id") REFERENCES "proxy_keys"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proxy_request_logs_channel_id_fkey'
  ) THEN
    ALTER TABLE "proxy_request_logs"
      ADD CONSTRAINT "proxy_request_logs_channel_id_fkey"
      FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'proxy_request_logs_model_id_fkey'
  ) THEN
    ALTER TABLE "proxy_request_logs"
      ADD CONSTRAINT "proxy_request_logs_model_id_fkey"
      FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
END $$;

-- ==========================================
-- 5. 索引（已存在则跳过）
-- ==========================================

CREATE INDEX IF NOT EXISTS "check_logs_model_id_created_at_idx" ON "check_logs"("model_id", "created_at");
CREATE INDEX IF NOT EXISTS "check_logs_created_at_idx" ON "check_logs"("created_at");
CREATE INDEX IF NOT EXISTS "channel_keys_channel_id_idx" ON "channel_keys"("channel_id");
CREATE INDEX IF NOT EXISTS "models_channel_key_id_idx" ON "models"("channel_key_id");
CREATE UNIQUE INDEX IF NOT EXISTS "channels_name_key" ON "channels"("name");
CREATE UNIQUE INDEX IF NOT EXISTS "model_keywords_keyword_key" ON "model_keywords"("keyword");

CREATE INDEX IF NOT EXISTS "proxy_request_logs_created_at_idx" ON "proxy_request_logs"("created_at");
CREATE INDEX IF NOT EXISTS "proxy_request_logs_success_created_at_idx" ON "proxy_request_logs"("success", "created_at");
CREATE INDEX IF NOT EXISTS "proxy_request_logs_endpoint_type_created_at_idx" ON "proxy_request_logs"("endpoint_type", "created_at");
CREATE INDEX IF NOT EXISTS "proxy_request_logs_requested_model_created_at_idx" ON "proxy_request_logs"("requested_model", "created_at");
CREATE INDEX IF NOT EXISTS "proxy_request_logs_channel_id_created_at_idx" ON "proxy_request_logs"("channel_id", "created_at");
CREATE INDEX IF NOT EXISTS "proxy_request_logs_proxy_key_id_created_at_idx" ON "proxy_request_logs"("proxy_key_id", "created_at");
CREATE INDEX IF NOT EXISTS "proxy_request_logs_model_id_created_at_idx" ON "proxy_request_logs"("model_id", "created_at");
