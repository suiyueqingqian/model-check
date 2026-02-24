<div align="center">

# 🔍 Model Check

**AI 模型可用性检测与管理平台**

[快速开始](#-快速开始) · [功能特性](#-功能特性) · [配置说明](#-配置说明) · [常见问题](#-常见问题)

</div>

---

## ✨ 功能特性

### 📡 渠道管理
- 支持添加、编辑、删除 API 渠道
- 批量导入导出（JSON 格式）
- WebDAV 云同步（支持坚果云、NextCloud 等）
- 多密钥管理：每个渠道可配置多个 API Key
- 负载均衡：支持轮询（round_robin）和随机（random）策略

### 🔬 模型检测
- 自动识别模型类型（Chat、Image、Claude、Gemini、Codex 等）
- 智能路由到对应的 API 端点进行检测
- 支持手动触发和定时自动检测
- 并发控制：可配置单渠道/全局并发数，避免触发限流
- 检测结果可视化，记录延迟和错误信息

### 🔑 代理接口
- 统一的 API 代理入口 `/api/proxy/v1/chat/completions`
- 多密钥管理：支持创建多个代理密钥
- 权限控制：可限制密钥访问的渠道和模型
- 自动路由：根据请求的模型名自动选择可用渠道

### ⏰ 定时任务
- 可视化配置检测周期（Cron 表达式）
- 支持选择特定渠道或模型进行检测
- 自动清理过期日志

## 🚀 快速开始

### 一键部署

```bash
git clone https://github.com/chxcodepro/model-check.git
cd model-check
bash deploy.sh
```

脚本会自动引导你完成配置，包括设置密码、数据库等。

### 部署选项

| 命令 | 说明 |
|------|------|
| `bash deploy.sh --local` | 全本地模式（默认） |
| `bash deploy.sh --cloud-db` | 云数据库 + 本地 Redis |
| `bash deploy.sh --cloud-redis` | 本地数据库 + 云 Redis |
| `bash deploy.sh --cloud` | 全云端模式 |
| `bash deploy.sh --quick` | 快速模式，跳过可选配置 |
| `bash deploy.sh --update` | 更新部署 |
| `bash deploy.sh --status` | 查看服务状态 |

### ☁️ 云服务推荐

| 服务 | 推荐 |
|------|------|
| PostgreSQL | [Supabase](https://supabase.com) (免费)、[Neon](https://neon.tech) (免费) |
| Redis | [Upstash](https://upstash.com) (免费)、Redis Cloud |

## 💻 本地开发

```bash
# 克隆项目
git clone https://github.com/chxcodepro/model-check.git
cd model-check

# 配置环境变量
cp .env.example .env
```

修改 `.env` 中的数据库连接为 localhost：

```bash
DATABASE_URL="postgresql://modelcheck:modelcheck123456@localhost:5432/model_check"
REDIS_URL="redis://localhost:6379"
```

启动服务：

```bash
# 启动数据库
docker compose up -d postgres redis

# 安装依赖
npm install

# 初始化数据库
npm run db:push

# 启动开发服务器
npm run dev
```

<details>
<summary>📦 其他命令</summary>

```bash
npm run db:studio    # 打开数据库管理界面
npm run db:seed      # 填充种子数据
npm test             # 运行测试
```

</details>

## ⚙️ 配置说明

配置文件 `.env`，修改后需重启服务。完整配置参考 `.env.example`

### 必选配置

| 变量 | 说明 |
|------|------|
| `ADMIN_PASSWORD` | 管理员登录密码 |
| `JWT_SECRET` | JWT 签名密钥，`openssl rand -base64 32` 生成 |

### 数据库配置

| 变量 | 说明 |
|------|------|
| `DATABASE_URL` | PostgreSQL 连接字符串（本地开发用 localhost） |
| `REDIS_URL` | Redis 连接字符串（本地开发用 localhost） |
| `DOCKER_DATABASE_URL` | Docker 容器内数据库连接（云端模式使用） |
| `DOCKER_REDIS_URL` | Docker 容器内 Redis 连接（云端模式使用） |

<details>
<summary>🔍 检测配置</summary>

| 变量 | 说明 | 默认值 |
|------|------|--------|
| `AUTO_DETECT_ENABLED` | 启用自动检测 | `false` |
| `AUTO_DETECT_ALL_CHANNELS` | 检测全部渠道 | `true` |
| `DETECT_PROMPT` | 检测提示词 | `1+1=2? yes or no` |
| `CRON_SCHEDULE` | 检测周期 (Cron) | `0 0,8,12,16,20 * * *` |
| `CRON_TIMEZONE` | 定时任务时区 | `Asia/Shanghai` |
| `CHANNEL_CONCURRENCY` | 单渠道并发数 | `5` |
| `MAX_GLOBAL_CONCURRENCY` | 全局最大并发数 | `30` |

</details>

<details>
<summary>🔧 可选配置</summary>

| 变量 | 说明 |
|------|------|
| `GLOBAL_PROXY` | 全局代理地址，支持 HTTP/SOCKS5 |
| `PROXY_API_KEY` | 代理接口密钥，不设置则自动生成 |
| `WEBDAV_URL` | WebDAV 服务器地址 |
| `WEBDAV_USERNAME` | WebDAV 用户名 |
| `WEBDAV_PASSWORD` | WebDAV 密码/应用密码 |
| `WEBDAV_FILENAME` | 同步文件名 |
| `LOG_RETENTION_DAYS` | 日志保留天数，默认 `7` |

</details>

## 🛠️ 常用命令

```bash
docker logs -f model-check     # 查看日志
docker compose restart         # 重启服务
docker compose down            # 停止服务
bash deploy.sh --update           # 更新部署
```

## ❓ 常见问题

<details>
<summary><b>每次重启后需要重新登录？</b></summary>

设置固定的 `JWT_SECRET` 环境变量，不设置的话每次重启都会重新生成。

</details>

<details>
<summary><b>坚果云 WebDAV 连接失败？</b></summary>

1. 使用应用密码，不是登录密码
2. 先在坚果云网页端创建同步文件夹
3. `WEBDAV_URL` 要包含文件夹路径，如 `https://dav.jianguoyun.com/dav/sync/`

</details>

<details>
<summary><b>检测任务卡住怎么办？</b></summary>

1. 检查 Redis 连接状态：`bash deploy.sh --status`
2. 查看日志定位问题：`docker logs model-check`
3. 重启服务：`docker compose restart`

</details>

<details>
<summary><b>如何使用代理接口？</b></summary>

1. 进入管理面板 → 代理密钥管理 → 添加密钥
2. 使用生成的密钥调用 `/api/proxy/v1/chat/completions`

</details>

<details>
<summary><b>本地开发连不上数据库？</b></summary>

确保 `.env` 中 `DATABASE_URL` 和 `REDIS_URL` 使用 `localhost` 而不是容器名 `postgres`/`redis`。

</details>

<details>
<summary><b>如何配置渠道多密钥？</b></summary>

编辑渠道时可以添加多个 API Key，并选择负载均衡策略（轮询或随机）。

</details>

## 📄 许可证

[MIT](LICENSE)

---

<div align="center">

**如果这个项目对你有帮助，欢迎 ⭐️ Star 支持一下！**

</div>
