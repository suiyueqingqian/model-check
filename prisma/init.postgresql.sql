-- NewAPI Model Check - PostgreSQL 数据库初始化脚本
-- 通常由 Prisma (npx prisma db push) 自动管理表结构
-- 此脚本用于手动初始化或不使用 Prisma CLI 的场景

CREATE TABLE IF NOT EXISTS "channels" (
  "id" TEXT NOT NULL,
  "name" VARCHAR(100) NOT NULL,
  "base_url" VARCHAR(500) NOT NULL,
  "api_key" TEXT NOT NULL,
  "type" TEXT NOT NULL DEFAULT 'NEWAPI',
  "proxy" VARCHAR(500),
  "enabled" BOOLEAN NOT NULL DEFAULT true,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "channels_type_check" CHECK ("type" IN ('NEWAPI', 'DIRECT'))
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
  "endpoint_type" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "latency" INTEGER,
  "status_code" INTEGER,
  "error_msg" TEXT,
  "response_content" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("id"),
  CONSTRAINT "check_logs_endpoint_type_check" CHECK ("endpoint_type" IN ('CHAT', 'CLAUDE', 'GEMINI', 'CODEX')),
  CONSTRAINT "check_logs_status_check" CHECK ("status" IN ('SUCCESS', 'FAIL')),
  CONSTRAINT "check_logs_model_id_fkey" FOREIGN KEY ("model_id") REFERENCES "models"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "check_logs_model_id_created_at_idx" ON "check_logs"("model_id", "created_at");
CREATE INDEX IF NOT EXISTS "check_logs_created_at_idx" ON "check_logs"("created_at");
