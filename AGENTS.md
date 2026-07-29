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
cp docker-compose.example.yml docker-compose.yml     # 首次使用：复制示例文件
docker compose up -d                                 # 本地运行
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
| `/api/dashboard` | GET | 无 | 聚合统计（total + today + yesterday + daily + models + 365 天 heatmap + 24h 分布） |
| `/api/providers` | GET | 无 | Provider 列表 |
| `/api/models` | GET | 无 | Model 列表 |
| `/api/records` | GET | `X-API-Key` header | 原始记录分页查询（每页 max 200） |

- **认证中间件**：`src/middleware.ts`，拦截 `/api/ingest` 与 `/api/records`
- **API Keys**：`API_KEYS` 环境变量，逗号分隔多个 key

## 数据处理约定

### Dashboard 视图
- `src/components/UsageHeatmap.tsx`：头部 GitHub 风格 365 天使用热力图，按 input + output tokens 分档着色，移动端横向滚动。
- `src/components/DailyUsageChart.tsx`：N 日使用趋势 + “Last N Days” 汇总卡片，其中第 5 张卡片展示 24 小时平均分布直方图（纯 CSS 柱）。
- `src/components/StatsCards.tsx` / `TodayOverview.tsx` / `TopModelsCards.tsx`：其余统计卡片。

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

## 查询缓存

- 项目在 **SQLite 驱动层**使用 `lru-cache` 实现了 SELECT 结果缓存，由 `src/lib/db/cache.ts` 管理。
- 通过 `wrapDatabaseClient()` 包装 `better-sqlite3` 的 `prepare` 方法，对 `select`/`pragma`/`with` 语句自动缓存，对其他语句（INSERT/UPDATE/DELETE）自动清空缓存。
- 默认 TTL 10 秒（`API_CACHE_TTL_MS`），时间参数按 10 秒桶取整作为缓存 key，保证同一窗口内查询共享缓存。
- 带 `X-API-Key` 的请求（`/api/ingest`、`/api/records`）通过 `AsyncLocalStorage` 跳过缓存，直接查库。
- 因此 `/api/dashboard`、`/api/providers`、`/api/models`、`/api/cli` 自动享受缓存；写入 `/api/ingest` 后自动清空缓存，后续 GET 立即读到新数据。
- 相关文件：`src/lib/db/cache.ts`、`src/lib/db/index.ts`、`src/app/api/ingest/route.ts`、`src/app/api/records/route.ts`
- **提醒**：如果未来新增写入接口（如新的 POST/PUT/DELETE 路由），必须在写入成功处调用 `invalidateQueryCache()` 清空缓存，或将 handler 包进 `withSkipCache()` 以确保一致性。

## 时区

- Dashboard 的所有日期/时间分组与显示均按**浏览器时区**对齐。
- `Dashboard.tsx` 通过 `new Date().getTimezoneOffset()` 获取客户端偏移分钟数（例如 UTC+8 返回 `-480`），并通过 `tzOffset` 查询参数传递给 `/api/dashboard`。
- 服务端使用 `src/lib/timezone-utils.ts` 中的助手函数将 UTC 的 `created_at` 转换为本地日期/小时进行分组和过滤。
- 相关文件：`src/lib/timezone-utils.ts`、`src/lib/db/index.ts`、`src/lib/stats-query.ts`、`src/app/api/dashboard/route.ts`、`src/components/Dashboard.tsx`、`src/components/UsageHeatmap.tsx`、`src/components/DailyUsageChart.tsx`。

## 环境变量

```bash
# SQLite（必需）
SQLITE_DATABASE_PATH="./data/token-tracker.db"

# API Keys（必需）
API_KEYS="your-secret-key"          # 可设置多个，逗号分隔

# 可选
HIDDEN_PROVIDERS="openai,google"    # 需要匿名的 provider 列表
MODEL_REGISTRY_PATH=                # model 归一化/价格配置（默认 data/model-registry.json，不存在则自动创建空文件）

# Query Cache
API_CACHE_TTL_MS=10000              # SELECT 缓存 TTL（毫秒），默认 10000，0 关闭
API_CACHE_MAX_SIZE=1000             # 缓存最大条目数，默认 1000
# API_CACHE_DEBUG=true              # 设为 true 在日志中输出缓存命中/未命中
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

# 或用 docker-compose.example.yml（推荐）
cp docker-compose.example.yml docker-compose.yml
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
