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
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "models" (
  "id" TEXT NOT NULL,
  "channel_id" TEXT NOT NULL,
  "model_name" VARCHAR(200) NOT NULL,
  "detected_endpoints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "last_status" BOOLEAN,
  "last_latency" INTEGER,
  "last_checked_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "models_channel_id_model_name_key" UNIQUE ("channel_id", "model_name"),
  CONSTRAINT "models_channel_id_fkey" FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE CASCADE ON UPDATE CASCADE
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
  "last_used_at" TIMESTAMP(3),
  "usage_count" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "proxy_keys_key_key" UNIQUE ("key")
);

-- ==========================================
-- 3. 兼容升级：逐字段补齐（已存在则跳过）
-- ==========================================

-- channels: 后加的排序字段
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "proxy" VARCHAR(500);
ALTER TABLE "channels" ADD COLUMN IF NOT EXISTS "sort_order" INTEGER NOT NULL DEFAULT 0;

-- models: 后加的检测端点、状态字段
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "detected_endpoints" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "last_status" BOOLEAN;
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "last_latency" INTEGER;
ALTER TABLE "models" ADD COLUMN IF NOT EXISTS "last_checked_at" TIMESTAMP(3);

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

-- ==========================================
-- 4. 索引（已存在则跳过）
-- ==========================================

CREATE INDEX IF NOT EXISTS "check_logs_model_id_created_at_idx" ON "check_logs"("model_id", "created_at");
CREATE INDEX IF NOT EXISTS "check_logs_created_at_idx" ON "check_logs"("created_at");
