# Model Check

AI 模型 API 渠道可用性监控面板 & 统一代理网关。

自动检测多个 API 渠道的模型可用性和响应延迟，同时提供兼容 OpenAI / Anthropic / Gemini 格式的统一代理转发接口。

## 功能特性

- **多渠道管理** — 集中管理 OpenAI、Claude、Gemini 等多家 API 提供商
- **定时可用性检测** — Cron 定时任务自动检测各渠道模型状态和延迟
- **统一代理网关** — 兼容 OpenAI Chat / Claude Messages / Gemini / OpenAI Responses 四种 API 格式
- **多密钥权限控制** — 可创建多个代理密钥，独立配置可访问的渠道和模型
- **实时进度推送** — SSE + Redis Pub/Sub 实时展示检测进度
- **WebDAV 同步** — 支持坚果云、NextCloud 等 WebDAV 服务备份渠道配置
- **代理支持** — 全局 HTTP/HTTPS/SOCKS5 代理

## 技术栈

| 层级 | 技术 |
|------|------|
| 框架 | Next.js 16 (App Router) + React 19 |
| 语言 | TypeScript |
| 数据库 | PostgreSQL 16 (Prisma ORM v7) |
| 缓存/队列 | Redis 7 (ioredis + BullMQ) |
| UI | shadcn/ui + Tailwind CSS v4 |
| 部署 | Docker + Docker Compose |
| CI/CD | GitHub Actions → GHCR |

## 快速开始

### 一键部署（推荐）

```bash
# 下载部署脚本
curl -fsSL https://raw.githubusercontent.com/chxcodepro/model-check/master/deploy.sh -o deploy.sh

# 添加执行权限
chmod +x deploy.sh

# 全本地模式部署（PostgreSQL + Redis 本地运行）
./deploy.sh --local
```

部署脚本会自动安装 Docker（如未安装）、引导配置环境变量、启动服务并初始化数据库。

### 部署模式

| 选项 | 说明 |
|------|------|
| `--local` | 全本地模式，PostgreSQL + Redis 均在本地 Docker 运行 |
| `--cloud-db` | 云数据库模式，仅本地运行 Redis（数据库使用 Supabase/Neon 等） |
| `--cloud-redis` | 云 Redis 模式，仅本地运行 PostgreSQL（Redis 使用 Upstash 等） |
| `--cloud` | 全云端模式，不启动本地数据库服务 |

其他选项：

| 选项 | 说明 |
|------|------|
| `--quick` | 快速模式，跳过可选配置 |
| `--rebuild` | 强制重新构建镜像 |
| `--update` | 更新部署（拉取最新镜像并重启） |
| `--status` | 查看服务运行状态 |
| `--help` | 显示帮助信息 |

### 手动部署

```bash
# 克隆仓库
git clone https://github.com/chxcodepro/model-check.git
cd model-check

# 复制并编辑环境变量
cp .env.example .env
# 编辑 .env，至少修改 ADMIN_PASSWORD 和 JWT_SECRET

# 启动服务
docker compose up -d
```

## 环境变量

复制 `.env.example` 为 `.env`，按需修改：

### 必须配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `ADMIN_PASSWORD` | 管理员登录密码 | `change-this-password` |
| `JWT_SECRET` | JWT 签名密钥（不设置则每次重启会话失效） | `change-this-secret-key` |

### 部署模式

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `COMPOSE_PROFILES` | `local` / `db` / `redis` / 不设置 | `local` |

### 数据库连接

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | 本地开发用数据库连接 |
| `DOCKER_DATABASE_URL` | Docker 容器内数据库连接（云数据库时设置） |
| `REDIS_URL` | 本地开发用 Redis 连接 |
| `DOCKER_REDIS_URL` | Docker 容器内 Redis 连接（云 Redis 时设置） |

### 可选配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `AUTO_DETECT_ENABLED` | 启动时自动开始检测 | `false` |
| `DETECT_PROMPT` | 检测使用的提示词 | `1+1=2? yes or no` |
| `GLOBAL_PROXY` | 全局代理（HTTP/HTTPS/SOCKS5） | — |
| `CRON_SCHEDULE` | 检测周期（cron 格式） | `0 0,8,12,16,20 * * *` |
| `CRON_TIMEZONE` | 定时任务时区 | `Asia/Shanghai` |
| `CHANNEL_CONCURRENCY` | 单渠道最大并发数 | `5` |
| `MAX_GLOBAL_CONCURRENCY` | 全局最大并发数 | `30` |
| `CLEANUP_SCHEDULE` | 日志清理周期 | `0 2 * * *` |
| `LOG_RETENTION_DAYS` | 日志保留天数 | `7` |
| `PROXY_API_KEY` | 代理接口密钥（不设置则自动生成） | — |

### 端口映射

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `APP_PORT` | 应用端口 | `3000` |
| `POSTGRES_PORT` | PostgreSQL 端口 | `5432` |
| `REDIS_PORT` | Redis 端口 | `6379` |

### WebDAV 同步（可选）

| 变量 | 说明 |
|------|------|
| `WEBDAV_URL` | WebDAV 服务器地址 |
| `WEBDAV_USERNAME` | 用户名 |
| `WEBDAV_PASSWORD` | 密码/应用密码 |
| `WEBDAV_FILENAME` | 同步文件路径 |

> 坚果云用户需先在网页端创建同步文件夹，并使用应用密码而非登录密码。

## 代理网关

应用内置统一代理网关，支持以下 API 格式：

| 端点 | 兼容格式 |
|------|----------|
| `/v1/chat/completions` | OpenAI Chat Completions |
| `/v1/messages` | Anthropic Claude Messages |
| `/v1beta/models/{model}:generateContent` | Google Gemini |
| `/v1/responses` | OpenAI Responses |
| `/v1/models` | 模型列表 |

使用方式：将 API Base URL 设置为 `http://<your-host>:<port>`，使用管理面板中创建的代理密钥作为 API Key。

支持 `渠道名/模型名` 格式精确指定使用的渠道。

## 本地开发

```bash
# 安装依赖
npm install

# 启动本地 PostgreSQL + Redis（需要 Docker）
docker compose up postgres redis -d

# 推送数据库 schema
npm run db:push

# 启动开发服务器
npm run dev
```

### 常用命令

| 命令 | 说明 |
|------|------|
| `npm run dev` | 启动开发服务器 |
| `npm run build` | 生产构建 |
| `npm run start` | 启动生产服务器 |
| `npm run lint` | ESLint 检查 |
| `npm run test` | 运行测试（watch 模式） |
| `npm run test:run` | 运行测试（单次） |
| `npm run db:generate` | 生成 Prisma 客户端 |
| `npm run db:push` | 推送 Schema 到数据库 |
| `npm run db:seed` | 运行数据库种子脚本 |
| `npm run db:studio` | 启动 Prisma Studio |
| `npm run test:connections` | 测试数据库/Redis 连接 |

## 项目结构

```
model-check/
├── src/
│   ├── app/
│   │   ├── api/              # 后端 API 路由
│   │   ├── v1/               # 代理网关端点（OpenAI/Claude）
│   │   ├── v1beta/           # 代理网关端点（Gemini）
│   │   ├── docs/             # 代理 API 文档页面
│   │   └── page.tsx          # Dashboard 主页面
│   ├── components/           # React 组件
│   ├── hooks/                # React Hooks
│   └── lib/
│       ├── detection/        # 检测引擎
│       ├── proxy/            # 代理网关核心逻辑
│       ├── queue/            # BullMQ 任务队列
│       ├── scheduler/        # Cron 定时任务
│       ├── webdav/           # WebDAV 同步
│       ├── prisma.ts         # 数据库客户端
│       └── redis.ts          # Redis 客户端
├── prisma/
│   ├── schema.prisma         # 数据模型定义
│   └── init.postgresql.sql   # 数据库初始化 SQL
├── deploy.sh                 # 一键部署脚本
├── docker-compose.yml        # Docker Compose 编排
├── Dockerfile                # 多阶段 Docker 构建
└── .env.example              # 环境变量模板
```

## License

MIT
