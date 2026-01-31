# ==========================================
# NewAPI Model Check - 一键部署脚本 (PowerShell)
# ==========================================
# 项目地址: https://github.com/chxcodepro/newapi-model-check
# 用法: .\deploy.ps1 [-Mode <模式>] [-Rebuild]
#
# 模式:
#   local       全本地模式（PostgreSQL + Redis 本地运行）
#   cloud-db    云数据库模式（仅启动 Redis）
#   cloud-redis 云 Redis 模式（仅启动 PostgreSQL）
#   cloud       全云端模式（不启动数据库服务）
#
# 示例:
#   .\deploy.ps1                    # 默认本地模式
#   .\deploy.ps1 -Mode cloud-db     # 使用云数据库
#   .\deploy.ps1 -Mode cloud        # 全云端模式
#   .\deploy.ps1 -Rebuild           # 强制重新构建

param(
    [ValidateSet("local", "cloud-db", "cloud-redis", "cloud")]
    [string]$Mode = "local",
    [switch]$Rebuild,
    [switch]$Help
)

$ErrorActionPreference = "Stop"

# 颜色输出函数
function Write-Info { Write-Host "[INFO] $args" -ForegroundColor Blue }
function Write-Success { Write-Host "[OK] $args" -ForegroundColor Green }
function Write-Warn { Write-Host "[WARN] $args" -ForegroundColor Yellow }
function Write-Err { Write-Host "[ERROR] $args" -ForegroundColor Red; exit 1 }

# 显示 Banner
function Show-Banner {
    Write-Host ""
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host "   NewAPI Model Check - 一键部署脚本 (Windows)  " -ForegroundColor Cyan
    Write-Host "  https://github.com/chxcodepro/newapi-model-check" -ForegroundColor Cyan
    Write-Host "================================================" -ForegroundColor Cyan
    Write-Host ""
}

# 显示帮助
function Show-Help {
    Write-Host "用法: .\deploy.ps1 [-Mode <模式>] [-Rebuild]"
    Write-Host ""
    Write-Host "部署模式:"
    Write-Host "  local       全本地模式 - PostgreSQL + Redis 本地运行（默认）"
    Write-Host "  cloud-db    云数据库模式 - 使用云端数据库，本地 Redis"
    Write-Host "  cloud-redis 云 Redis 模式 - 本地数据库，使用云端 Redis"
    Write-Host "  cloud       全云端模式 - 数据库和 Redis 都使用云端服务"
    Write-Host ""
    Write-Host "其他选项:"
    Write-Host "  -Rebuild    强制重新构建镜像"
    Write-Host "  -Help       显示此帮助信息"
    Write-Host ""
    Write-Host "云服务推荐:"
    Write-Host "  PostgreSQL: Supabase (免费), Neon (免费)"
    Write-Host "  TiDB:       TiDB Cloud (免费额度)"
    Write-Host "  Redis:      Upstash (免费), Redis Cloud"
    Write-Host ""
    Write-Host "示例:"
    Write-Host "  .\deploy.ps1                     # 本地模式部署"
    Write-Host "  .\deploy.ps1 -Mode cloud-db      # 使用 Supabase/Neon 云数据库"
    Write-Host "  .\deploy.ps1 -Mode cloud         # 全云端模式"
    Write-Host "  .\deploy.ps1 -Rebuild            # 重新构建镜像"
    exit 0
}

# 检查依赖
function Test-Dependencies {
    Write-Info "检查系统依赖..."

    # 检查 Docker
    try {
        $null = docker version 2>&1
    } catch {
        Write-Warn "未找到 Docker"
        $install = Read-Host "是否自动安装 Docker Desktop? (Y/n)"
        if ($install -notmatch "^[Nn]$") {
            Write-Info "正在下载 Docker Desktop 安装器..."
            Write-Host "请按照安装向导完成安装，安装完成后重新运行此脚本"
            Write-Host ""
            Write-Host "  下载地址: https://desktop.docker.com/win/main/amd64/Docker%20Desktop%20Installer.exe"
            Write-Host ""
            # 尝试使用 winget 安装
            try {
                winget install Docker.DockerDesktop --accept-package-agreements --accept-source-agreements
                Write-Success "Docker Desktop 安装完成，请启动 Docker Desktop 后重新运行此脚本"
            } catch {
                Write-Host "自动安装失败，请手动下载安装: https://www.docker.com/products/docker-desktop/"
            }
            exit 0
        } else {
            Write-Err "Docker 是必需的，请先安装 Docker Desktop: https://docs.docker.com/desktop/install/windows-install/"
        }
    }

    # 检查 Docker 是否运行
    try {
        $null = docker info 2>&1
        if ($LASTEXITCODE -ne 0) { throw }
    } catch {
        Write-Err "Docker 未运行，请先启动 Docker Desktop"
    }

    Write-Success "依赖检查通过"
}

# 生成随机密钥
function New-Secret {
    $bytes = New-Object byte[] 32
    $rng = [System.Security.Cryptography.RandomNumberGenerator]::Create()
    $rng.GetBytes($bytes)
    return [Convert]::ToBase64String($bytes)
}

# 更新 .env 文件中的配置
function Update-EnvValue {
    param(
        [string]$FilePath,
        [string]$Key,
        [string]$Value,
        [switch]$Uncomment
    )

    $content = Get-Content $FilePath -Raw
    # 转义替换字符串中的特殊字符: $ -> $$, \ -> \\, " -> \"
    $escapedValue = $Value -replace '\$', '$$$$' -replace '\\', '\\' -replace '"', '\"'

    if ($Uncomment) {
        # 取消注释并设置值
        $content = $content -replace "(?m)^#\s*${Key}=.*$", "${Key}=`"${escapedValue}`""
    }

    # 替换现有值
    $content = $content -replace "(?m)^${Key}=.*$", "${Key}=`"${escapedValue}`""

    Set-Content $FilePath -Value $content -NoNewline
}

# 创建 .env 文件
function Initialize-EnvFile {
    param([string]$DeployMode)

    if (Test-Path ".env") {
        Write-Warn ".env 文件已存在"
        $overwrite = Read-Host "是否覆盖? (y/N)"
        if ($overwrite -notmatch "^[Yy]$") {
            Write-Info "保留现有 .env 文件"
            return
        }
        Copy-Item ".env" ".env.backup" -Force
        Write-Success "已备份到 .env.backup"
    }

    Write-Info "创建 .env 配置文件..."
    Copy-Item ".env.example" ".env" -Force

    # 设置部署模式
    $profileValue = switch ($DeployMode) {
        "local"       { "local" }
        "cloud-db"    { "redis" }
        "cloud-redis" { "db" }
        "cloud"       { "" }
    }
    Update-EnvValue -FilePath ".env" -Key "COMPOSE_PROFILES" -Value $profileValue

    # 生成 JWT 密钥
    $jwtSecret = New-Secret
    Update-EnvValue -FilePath ".env" -Key "JWT_SECRET" -Value $jwtSecret
    Write-Success "已生成 JWT 密钥"

    # 设置管理员密码
    Write-Host ""
    $adminPwd = Read-Host "请输入管理员密码 (留空使用默认 admin123)" -AsSecureString
    $adminPwdText = [Runtime.InteropServices.Marshal]::PtrToStringAuto(
        [Runtime.InteropServices.Marshal]::SecureStringToBSTR($adminPwd)
    )

    if ([string]::IsNullOrEmpty($adminPwdText)) {
        Update-EnvValue -FilePath ".env" -Key "ADMIN_PASSWORD" -Value "admin123"
        Write-Warn "使用默认密码 admin123，建议后续修改"
    } else {
        Update-EnvValue -FilePath ".env" -Key "ADMIN_PASSWORD" -Value $adminPwdText
        Write-Success "已设置管理员密码"
    }

    # 云数据库配置
    if ($DeployMode -in @("cloud-db", "cloud")) {
        Write-Host ""
        Write-Info "请配置云数据库连接..."
        Write-Host "支持的格式:"
        Write-Host "  Supabase:  postgresql://postgres:password@db.xxx.supabase.co:5432/postgres"
        Write-Host "  Neon:      postgresql://user:password@xxx.neon.tech/neondb?sslmode=require"
        Write-Host "  TiDB:      mysql://user:password@gateway.tidbcloud.com:4000/dbname"
        Write-Host ""
        $dbUrl = Read-Host "数据库连接字符串"

        if ([string]::IsNullOrEmpty($dbUrl)) {
            Write-Err "云数据库模式必须提供连接字符串"
        }

        Update-EnvValue -FilePath ".env" -Key "DOCKER_DATABASE_URL" -Value $dbUrl -Uncomment
        Write-Success "已配置云数据库"
    }

    # 云 Redis 配置
    if ($DeployMode -in @("cloud-redis", "cloud")) {
        Write-Host ""
        Write-Info "请配置云 Redis 连接..."
        Write-Host "支持的格式:"
        Write-Host "  Upstash:     redis://default:password@xxx.upstash.io:6379"
        Write-Host "  Redis Cloud: redis://user:password@xxx.redis.cloud:port"
        Write-Host ""
        $redisUrl = Read-Host "Redis 连接字符串"

        if ([string]::IsNullOrEmpty($redisUrl)) {
            Write-Err "云 Redis 模式必须提供连接字符串"
        }

        Update-EnvValue -FilePath ".env" -Key "DOCKER_REDIS_URL" -Value $redisUrl -Uncomment
        Write-Success "已配置云 Redis"
    }

    Write-Success ".env 配置完成"
}

# 启动服务
function Start-Services {
    param([bool]$ForceRebuild)

    Write-Info "启动 Docker 服务..."

    if ($ForceRebuild) {
        docker compose up -d --build
    } else {
        docker compose up -d
    }

    if ($LASTEXITCODE -ne 0) {
        Write-Err "Docker 服务启动失败"
    }

    Write-Success "服务启动中..."

    # 等待服务就绪
    Write-Info "等待服务就绪..."
    $maxAttempts = 30
    $attempt = 0

    while ($attempt -lt $maxAttempts) {
        $status = docker ps --filter "name=newapi-model-check" --format "{{.Status}}" 2>$null
        if ($status -match "Up") {
            break
        }
        $attempt++
        Write-Host "." -NoNewline
        Start-Sleep -Seconds 2
    }
    Write-Host ""

    if ($attempt -eq $maxAttempts) {
        Write-Err "服务启动超时，请检查日志: docker logs newapi-model-check"
    }

    Write-Success "服务已启动"
}

# 初始化数据库
function Initialize-Database {
    Write-Info "初始化数据库..."

    # 检查是否有本地 PostgreSQL 容器
    $pgContainer = docker ps --format '{{.Names}}' | Select-String "newapi-postgres"
    if ($pgContainer) {
        Write-Info "等待数据库就绪..."
        $maxAttempts = 30
        $attempt = 0

        while ($attempt -lt $maxAttempts) {
            $null = docker compose exec -T postgres pg_isready -U newapi -d newapi_monitor 2>$null
            if ($LASTEXITCODE -eq 0) {
                break
            }
            $attempt++
            Write-Host "." -NoNewline
            Start-Sleep -Seconds 2
        }
        Write-Host ""

        if ($attempt -eq $maxAttempts) {
            Write-Warn "等待数据库超时，尝试继续..."
        }
    }

    # 等待 app 容器就绪
    Write-Info "等待应用容器就绪..."
    Start-Sleep -Seconds 5

    # 执行数据库迁移
    Write-Info "执行 Prisma 迁移..."
    docker compose exec -T app npx prisma db push --skip-generate

    if ($LASTEXITCODE -ne 0) {
        Write-Err "数据库初始化失败，请检查日志: docker logs newapi-model-check"
    }

    Write-Success "数据库初始化完成"
}

# 显示部署结果
function Show-Result {
    $port = if ($env:APP_PORT) { $env:APP_PORT } else { "3000" }

    Write-Host ""
    Write-Host "================================================" -ForegroundColor Green
    Write-Host "              部署成功!                         " -ForegroundColor Green
    Write-Host "================================================" -ForegroundColor Green
    Write-Host ""
    Write-Host "访问地址: " -NoNewline
    Write-Host "http://localhost:$port" -ForegroundColor Cyan
    Write-Host "管理密码: 你设置的 ADMIN_PASSWORD"
    Write-Host ""
    Write-Host "常用命令:"
    Write-Host "  查看日志:   docker logs -f newapi-model-check"
    Write-Host "  重启服务:   docker compose restart"
    Write-Host "  停止服务:   docker compose down"
    Write-Host "  更新部署:   git pull; docker compose up -d --build"
    Write-Host ""
    Write-Host "项目地址: https://github.com/chxcodepro/newapi-model-check"
    Write-Host ""
}

# 主函数
function Main {
    if ($Help) {
        Show-Help
    }

    Show-Banner

    Write-Info "部署模式: $Mode"
    Write-Host ""

    # 执行部署流程
    Test-Dependencies
    Initialize-EnvFile -DeployMode $Mode
    Start-Services -ForceRebuild $Rebuild
    Initialize-Database
    Show-Result
}

# 运行主函数
Main
