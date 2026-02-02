-- NewAPI Model Check - PostgreSQL 数据库初始化脚本
-- 通常由 Prisma (npx prisma db push) 自动管理表结构
-- 此脚本用于手动初始化或不使用 Prisma CLI 的场景

-- 创建枚举类型（Prisma 需要原生 ENUM 类型）
DO $$ BEGIN
    CREATE TYPE "EndpointType" AS ENUM ('CHAT', 'CLAUDE', 'GEMINI', 'CODEX');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
    CREATE TYPE "CheckStatus" AS ENUM ('SUCCESS', 'FAIL');
EXCEPTION
    WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS "channels" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "base_url" VARCHAR(500) NOT NULL,
  "api_key" TEXT NOT NULL,
  "proxy" VARCHAR(500),
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id")
);

CREATE TABLE IF NOT EXISTS "models" (
  "id" TEXT NOT NULL,
  "channel_id" TEXT NOT NULL,
  "model_name" VARCHAR(200) NOT NULL,
  "detected_endpoints" JSONB,
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

CREATE INDEX IF NOT EXISTS "check_logs_model_id_created_at_idx" ON "check_logs"("model_id", "created_at");
CREATE INDEX IF NOT EXISTS "check_logs_created_at_idx" ON "check_logs"("created_at");
