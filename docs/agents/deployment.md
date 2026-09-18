# 部署、前端安全与移动端适配

> 上级文档：`AGENTS.md`。改 env / Dockerfile / compose / 发布流程 / UI 前必读。

## Web 前端安全与 PWA

- **安全响应头**（`next.config.js` 全局 header，`:path*`）：`X-Frame-Options: DENY`（点击劫持）、`X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`、`Permissions-Policy`（禁 camera/mic/geolocation）、CSP：`default-src 'self'` + `script-src 'self' 'unsafe-inline'`（**dev 模式额外放行 `unsafe-eval`**，生产不放松；`unsafe-inline` 因 Next bootstrap/styled-jsx 需要）+ `frame-ancestors 'none'` + `object-src 'none'`；`poweredByHeader: false`（不暴露 x-powered-by 框架身份）
- **PWA 可安装性**：`src/app/manifest.ts`（manifest + 图标），无 Service Worker（离线能力未启用）；移动端底栏 `MobileTabBar.tsx`（`md:hidden`）
- **Docker 构建**：Dockerfile `output: 'standalone'` + base `node:22-slim` + `ENV NODE_OPTIONS=--max-old-space-size=256 --expose-gc`（生产内存控制：收紧 old space 上限 + `src/instrumentation.ts` instrumentationHook 每 5 分钟 RSS>64MB 时 full GC 归还内存，防长期运行 RSS 膨胀）；docker-compose.example.yml 含 `TRUSTED_PROXY` 与可选 `deploy.memory` 注释
- **TOTP 绑定二维码**：`qrcode.react`（^4.2.0）渲染 otpauth:// URI
- **`scripts/test_gateway.py`**：手动端到端网关测试脚本（虚拟 key → 代理请求 → 校验透传/写库），不入 vitest，仅供本地联调

## 移动端适配约定

- 任何 UI 改动必须同时考虑移动端（<768px）：新表格必须做「桌面 table + `md:hidden` 卡片」双轨；
  新弹窗移动端全屏（`w-full h-full md:...`）；新导航/按钮触摸区 ≥40px；input 移动端字号 ≥16px
- 移动端专属 UI 一律 `md:hidden` 门控，桌面端 DOM 只新增不修改
- **Admin 面板表格统一使用共享组件 `src/components/admin/table.tsx`**（`AdminTableCard` / `AdminTable` / `AdminTableHead` / `AdminTableBody` / `AdminTd` / `AdminTableEmptyRow` / `AdminMobileCards` / `AdminMobileCard` / `AdminMobileEmpty`），新增/修改 Admin 表格禁止手写 `<table>`——以 ModelsPanel 表格形式为基准：桌面 `hidden md:block overflow-x-auto`、数字列 `text-right font-mono text-xs`（`AdminTd align="right" mono`）、操作列 `text-right whitespace-nowrap`、移动端卡片 `border border-gray-200 rounded-lg p-3`（双 checkbox 行保留 `h-5 w-5`）。徽标语义各异不抽公共组件，各面板局部实现；`RecordsTable.tsx`（Dashboard）独立旧风格不受此约束
- 复用现有范式：RecordsTable 双轨、ActionMenu、FiltersModal、PriceSimulatorModal
- 提交前自检：375px 视口无横向溢出，桌面端视觉无回归

## 环境变量

```bash
# SQLite（必需）
SQLITE_DATABASE_PATH="./data/token-tracker.db"

# AI Gateway 主密钥（必需）
GATEWAY_SECRET=""                   # AES-256-GCM 32 字节（hex/base64）；openssl rand -hex 32

# 可选：bootstrap（未配置且 DB 无 key 时 Web 端出现首次设置向导）
# ADMIN_API_KEY="your-secret-key"   # 可设置多个，逗号分隔；旧名 API_KEYS 兼容（deprecated）

# 可选：也可在 admin panel Security/Display tab 配置（面板优先，env 仅 fallback）
SESSION_TOKEN_TTL_HOURS=24          # 会话 token 有效期（小时），默认 24，滑动续期；只影响新签发 token

# 安全：默认 false（fail-closed）。仅当前置反代已设置 X-Real-IP 并覆盖客户端 XFF 时设为 true。
# false 时登录/设置限流用全局桶（防 XFF 伪造绕过限流），审计 IP 记为 unknown；
# true 时恢复精确 IP 限流（取 x-real-ip，回退 XFF 末位）。反代需配：
#   proxy_set_header X-Real-IP $remote_addr;
#   proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
TRUSTED_PROXY=false

# 可选：进阶（代码保留 env 支持，不在 .env.example 中）
API_CACHE_TTL_MS=10000              # SELECT 缓存 TTL（毫秒），默认 10000，0 关闭
API_CACHE_MAX_SIZE=1000             # 缓存最大条目数，默认 1000
GATEWAY_MAX_BODY_MB=32              # 代理请求体上限（MB），默认 32；超限 413
ALLOW_PRIVATE_UPSTREAMS=false       # 设为 true 允许上游指向内网/环回/元数据地址（内网自建 LLM 逃生开关）
# API_CACHE_DEBUG=true              # 设为 true 在日志中输出缓存命中/未命中
```

- 本地开发复制 `.env.example` → `.env.local`

## Docker 部署（VPS 自托管）

```bash
# 1. 拉取镜像
docker pull ghcr.io/caibingcheng/token-tracker:latest

# 2. 准备 data 目录
mkdir -p /opt/token-tracker/data

# 3. 启动（必须设置 GATEWAY_SECRET）
docker run -d \
  --name token-tracker \
  -p 3000:3000 \
  -e SQLITE_DATABASE_PATH=/app/data/token-tracker.db \
  -e ADMIN_API_KEY=your-key-here \
  -e GATEWAY_SECRET=your-32-byte-hex \
  -v /opt/token-tracker/data:/app/data \
  ghcr.io/caibingcheng/token-tracker:latest

# 或用 docker-compose.example.yml（推荐）
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

- SQLite 数据库文件在首次 API 请求时由 `initDatabase()` 自动创建（含新表与存量补列），无需手动迁移

### GitHub Container Registry

| 触发条件 | 镜像标签 | 用途 |
|---------|---------|------|
| tag `v*.*.*`（如 `v1.3.0`） | `ghcr.io/caibingcheng/token-tracker:vX.Y.Z` + `:<short-sha>` | 生产发布 |
| tag `v*.*.*-dev*`（如 `v1.3.0-dev.1`） | 同上 + `:dev` | 开发版发布 |
| `workflow_dispatch` | 同上 | 手动重建 |
