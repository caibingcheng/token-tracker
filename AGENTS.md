# AGENTS.md

> 帮助未来 OpenCode 会话快速上手、避免常见错误。仅包含从代码库推断出的高信号事实。

## 项目概览

- **Token Tracker**：基于 Next.js 14 App Router + Drizzle ORM + SQLite 的 LLM Token 用量仪表盘
- **部署目标**：Docker VPS（SQLite）
- **使用规模**：个人使用，日均约 1000 条记录

## 开发者命令

```bash
# 开发
npm run dev                 # 启动开发服务器，访问 http://localhost:3000

# 数据库操作
npx drizzle-kit studio      # 启动 Drizzle Studio（SQLite）

# 构建与检查
npm run build               # 生产构建
npm run lint                # ESLint（仅 extends next/core-web-vitals）

# Docker
docker build -t token-tracker:test .                # 本地构建
docker compose up -d                                 # 本地运行（需 .env 文件）
```

## 数据库架构（Drizzle ORM）

- **Schema**：`src/lib/db/schema-sqlite.ts`（sqlite-core）
- **连接配置**：`src/lib/db/index.ts`，懒加载初始化
- **关键配置**：better-sqlite3，文本模式存储时间戳（ISO 格式）
- **自动初始化**：`initDatabase()` 在首次 API 调用时自动创建 `token_records` 表和索引
- **表结构**：`token_records`（id, model, provider, agent, input_tokens, output_tokens, cache_read, cache_write, created_at）
- **日期分组**：`getDateGroupExpr(granularity)` 使用 SQLite `strftime`

## API 路由与认证

| 路由 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/api/ingest` | POST | `X-API-Key` header | 上报 token 用量 |
| `/api/dashboard` | GET | 无 | 聚合统计（total + today + yesterday + daily + models） |
| `/api/providers` | GET | 无 | Provider 列表 |
| `/api/models` | GET | 无 | Model 列表 |
| `/api/records` | GET | `X-API-Key` header | 原始记录分页查询（每页 max 200） |

- **认证中间件**：`src/middleware.ts`，拦截 `/api/ingest` 与 `/api/records`
- **API Keys**：`API_KEYS` 环境变量，逗号分隔多个 key

## 数据处理约定

### Provider 匿名化
- **环境变量**：`HIDDEN_PROVIDERS`（逗号分隔；支持命名分组，如 `CustomA:vendor*`）
- **行为**：被隐藏的 provider 在 UI 中显示为 "Provider A", "Provider B"... 或自定义名称
- **相关文件**：`src/lib/provider-utils.ts`

### Model 归一化
- **文件**：`src/lib/model-registry.ts`（`src/lib/model-utils.ts` 仅做薄封装）
- **数据源**：`public/data/model-registry.json`（自维护 canonical ID、显示名、价格、别名）
- **规则**：按优先级依次匹配
  1. 精确匹配 canonical ID
  2. 精确匹配 `aliases` 中的 `provider/model` 别名
  3. 若 provider 被 `HIDDEN_PROVIDERS` 隐藏，则只按 `model` 部分匹配 `aliases` 中的别名
  4. 精确匹配 `aliases` 中的 `model` 别名
  5. 未命中时保持原始名称
- **用途**：Dashboard Top 5 按归一化后的 model 名称聚合（如 `kimi-for-coding/k2p7` → `moonshotai/kimi-k2.7-code`）
- **注**：不再依赖 `models.dev` 数据，所有模型、价格、别名均从 `model-registry.json` 维护；hidden provider 的别名不需要写入 registry，依赖 `HIDDEN_PROVIDERS` 的 fallback 规则归一化

## 环境变量

```bash
# SQLite（必需）
SQLITE_DATABASE_PATH="./data/token-tracker.db"

# API Keys（必需）
API_KEYS="your-secret-key"          # 可设置多个，逗号分隔

# 可选
HIDDEN_PROVIDERS="openai,google"    # 需要匿名的 provider 列表
MODEL_REGISTRY_PATH=                # model 归一化/价格配置（默认 data/model-registry.json，不存在则自动创建空文件）
```

- 本地开发复制 `.env.example` → `.env.local`
- Drizzle Kit 自动读取 `.env.local`（通过 `drizzle.config.ts` 中的 `dotenv.config()`）

## Docker 部署（VPS 自托管）

```bash
# 1. 拉取镜像
docker pull ghcr.io/caibingcheng/token-tracker:latest

# 2. 准备 data 目录
mkdir -p /opt/token-tracker/data

# 3. 启动
docker run -d \
  --name token-tracker \
  -p 3000:3000 \
  -e SQLITE_DATABASE_PATH=/app/data/token-tracker.db \
  -e API_KEYS=your-key-here \
  -v /opt/token-tracker/data:/app/data \
  ghcr.io/caibingcheng/token-tracker:latest

# 或用 docker-compose.yml（推荐）
docker compose up -d
```

- SQLite 数据库文件在首次 API 请求时由 `initDatabase()` 自动创建，无需手动迁移

### GitHub Container Registry

| 分支 | 镜像标签 | 用途 |
|------|---------|------|
| `master` | `ghcr.io/caibingcheng/token-tracker:latest` | 生产 |
| `dev` | `ghcr.io/caibingcheng/token-tracker:dev` | 测试 |
| 任意 | `ghcr.io/caibingcheng/token-tracker:<sha>` | 指定版本 |

- GHCR 公仓可直接 `docker pull`，无需登录
- 私仓需在 VPS 上 `docker login ghcr.io -u <用户名> -p <PAT>`

## Git Commit

- DO NOT and MUST NOT commit plan/spec files to the repository.
- Commit message must in English.
