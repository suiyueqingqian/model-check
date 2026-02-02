# NewAPI Model Check

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Next.js](https://img.shields.io/badge/Next.js-16-black)](https://nextjs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5-blue)](https://www.typescriptlang.org/)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-16-336791)](https://www.postgresql.org/)
[![TiDB](https://img.shields.io/badge/TiDB-Supported-red)](https://www.pingcap.com/)
[![Docker](https://img.shields.io/badge/Docker-Ready-2496ED)](https://www.docker.com/)

API 渠道可用性检测系统 - 实时监控多个 API 渠道的模型可用性状态。

## 功能特性

- **多端点检测** - 支持 OpenAI Chat、Claude、Gemini、Codex 等多种 API 格式
- **API 代理** - 统一代理入口，自动路由到对应渠道（支持 OpenAI/Claude/Gemini）
- **实时监控** - SSE 实时推送检测进度
- **定时任务** - 可配置的周期性检测（默认每 6 小时）
- **数据清理** - 自动清理过期日志（默认保留 7 天）
- **渠道管理** - 支持 WebDAV 同步、批量导入导出
- **多数据库** - 支持 PostgreSQL（默认）、TiDB、MySQL
- **深色模式** - 支持浅色/深色主题切换
- **一键部署** - Docker 一键部署（Linux / macOS）

## 快速开始

### 一键部署（Linux / macOS）

无需手动安装 Docker，脚本会自动检测并安装：

```bash
git clone https://github.com/chxcodepro/newapi-model-check.git
cd newapi-model-check
chmod +x deploy.sh && ./deploy.sh
```

部署脚本会自动完成：
1. 检测并安装 Docker
2. 生成安全的 JWT 密钥
3. 引导设置管理员密码
4. 启动 PostgreSQL + Redis + 应用
5. 初始化数据库

部署完成后访问 **http://localhost:3000**

### 部署模式

| 模式 | 命令 | 说明 |
|------|------|------|
| 本地模式 | `./deploy.sh` | PostgreSQL + Redis 本地运行（默认） |
| 云数据库 | `./deploy.sh --cloud-db` | 使用 Supabase/Neon/TiDB 云数据库 |
| 云 Redis | `./deploy.sh --cloud-redis` | 使用 Upstash 云 Redis |
| 全云端 | `./deploy.sh --cloud` | 数据库和 Redis 都使用云服务 |

### 手动部署

```bash
# 1. 克隆项目
git clone https://github.com/chxcodepro/newapi-model-check.git
cd newapi-model-check

# 2. 配置环境变量
cp .env.example .env
# 编辑 .env，设置 ADMIN_PASSWORD 和 JWT_SECRET

# 3. 启动服务
docker compose up -d

# 4. 初始化数据库
docker compose exec app npx prisma db push
```

## 数据库支持

### PostgreSQL（默认）

Docker 部署默认使用 PostgreSQL 16，无需额外配置。

**云服务推荐：**
- [Supabase](https://supabase.com) - 免费额度充足
- [Neon](https://neon.tech) - Serverless PostgreSQL

```bash
DOCKER_DATABASE_URL="postgresql://postgres:[PASSWORD]@db.[PROJECT].supabase.co:5432/postgres"
```

### TiDB Cloud

TiDB 是 MySQL 兼容的分布式数据库，适合大规模部署。

**使用步骤：**
1. 切换 Schema：
   ```bash
   cp prisma/schema.mysql.prisma prisma/schema.prisma
   ```
2. 配置连接串：
   ```bash
   DOCKER_DATABASE_URL="mysql://user:password@gateway01.xx.tidbcloud.com:4000/newapi_monitor?sslaccept=strict"
   ```
3. 重新构建：
   ```bash
   docker compose up -d --build
   ```

### MySQL

本地 MySQL 或其他 MySQL 兼容数据库同样支持，切换方式与 TiDB 相同。

## 环境变量

### 必须配置

| 变量 | 说明 | 示例 |
|------|------|------|
| `ADMIN_PASSWORD` | 管理员登录密码 | `MySecurePassword123` |
| `JWT_SECRET` | JWT 签名密钥（建议 32 位以上） | `openssl rand -base64 32` |

### 可选配置

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `DETECT_PROMPT` | 检测提示词 | `1+1=2? yes or no` |
| `GLOBAL_PROXY` | 全局代理地址 | - |
| `CRON_SCHEDULE` | 检测周期（cron 格式） | `0 */6 * * *` |
| `LOG_RETENTION_DAYS` | 日志保留天数 | `7` |
| `APP_PORT` | 应用端口 | `3000` |
| `PROXY_API_KEY` | 代理接口密钥（不设置则自动生成） | 自动生成 |
| `WEBDAV_URL` | WebDAV 服务器地址 | - |
| `WEBDAV_USERNAME` | WebDAV 用户名 | - |
| `WEBDAV_PASSWORD` | WebDAV 密码 | - |
| `WEBDAV_FILENAME` | WebDAV 同步文件名 | `newapi-channels.json` |

### 云 Redis

**Upstash（推荐）**
```bash
DOCKER_REDIS_URL="redis://default:[PASSWORD]@[ENDPOINT].upstash.io:6379"
```

## API 接口

| 端点 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/status` | GET | 否 | 健康检查 |
| `/api/dashboard` | GET | 否 | 仪表板数据 |
| `/api/auth/login` | POST | 否 | 管理员登录 |
| `/api/channel` | GET/POST/PUT/DELETE | 是 | 渠道 CRUD |
| `/api/channel/[id]/sync` | POST | 是 | 同步模型列表 |
| `/api/channel/import` | POST | 是 | 批量导入渠道 |
| `/api/channel/export` | GET | 是 | 导出渠道配置 |
| `/api/detect` | POST | 是 | 触发检测 |
| `/api/scheduler` | GET/POST | 是 | 调度器管理 |
| `/api/sse/progress` | GET | 否 | SSE 实时进度 |

### 代理接口

| 端点 | 方法 | 说明 |
|------|------|------|
| `/v1/models` | GET | 获取可用模型列表 |
| `/v1/chat/completions` | POST | OpenAI Chat API 代理 |
| `/v1/messages` | POST | Claude Messages API 代理 |
| `/v1/responses` | POST | OpenAI Responses API 代理 |
| `/v1beta/models/{model}:generateContent` | POST | Gemini API 代理 |
| `/v1beta/models/{model}:streamGenerateContent` | POST | Gemini 流式 API 代理 |

代理接口根据请求中的 `model` 字段自动路由到对应渠道。详细文档见 `/docs/proxy`。

## 项目结构

```
newapi-model-check/
├── src/
│   ├── app/                    # Next.js App Router
│   │   ├── api/               # API 路由
│   │   ├── docs/              # 文档页面
│   │   ├── v1/                # OpenAI/Claude 代理端点
│   │   └── v1beta/            # Gemini 代理端点
│   ├── components/            # React 组件
│   │   ├── dashboard/         # 仪表板
│   │   ├── layout/           # 布局
│   │   └── ui/               # UI 组件
│   ├── hooks/                 # React Hooks
│   └── lib/                   # 核心库
│       ├── detection/        # 检测策略
│       ├── proxy/            # 代理工具
│       ├── queue/            # BullMQ 队列
│       └── scheduler/        # Cron 调度
├── prisma/
│   ├── schema.prisma         # PostgreSQL Schema（默认）
│   └── schema.mysql.prisma   # MySQL/TiDB Schema
├── docker-compose.yml
├── Dockerfile
└── deploy.sh                  # Linux/macOS 部署脚本
```

## 技术栈

| 类别 | 技术 |
|------|------|
| 框架 | Next.js 16 (App Router) |
| 语言 | TypeScript 5 |
| 数据库 | PostgreSQL / TiDB / MySQL + Prisma ORM |
| 队列 | Redis 7 + BullMQ |
| UI | Tailwind CSS + Lucide Icons |
| 认证 | JWT |
| 部署 | Docker + Docker Compose |

## 常用命令

```bash
# 查看日志
docker logs -f newapi-model-check

# 重启服务
docker compose restart

# 停止服务
docker compose down

# 更新部署
git pull && docker compose up -d --build

# 本地开发
npm install
npm run dev

# 切换到 MySQL/TiDB
cp prisma/schema.mysql.prisma prisma/schema.prisma
npx prisma generate
```

## 常见问题

**Q: 忘记管理员密码？**

修改 `.env` 中的 `ADMIN_PASSWORD`，然后重启：`docker compose restart`

**Q: 如何修改检测间隔？**

修改 `.env` 中的 `CRON_SCHEDULE`（cron 格式），如每小时：`0 * * * *`

**Q: 如何切换到 TiDB/MySQL？**

```bash
cp prisma/schema.mysql.prisma prisma/schema.prisma
docker compose up -d --build
```

**Q: Docker 构建失败？**

镜像已配置国内加速源，如仍有问题可配置 Docker 镜像加速器。

## License

[MIT](LICENSE)
