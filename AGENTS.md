# AGENTS.md

> 帮助未来 OpenCode 会话快速上手、避免常见错误。仅包含从代码库推断出的高信号事实。

## 项目概览

- **Token Tracker**：基于 Next.js 14 App Router + Drizzle ORM + SQLite 的**个人 AI Gateway**（LLM Token 用量仪表盘 + 多协议上游代理）
- **网关定位**：`/v1/*` + `/v1beta/*` catch-all 纯透传（OpenAI/Anthropic/Gemini 三协议），透传中自动解析 token 用量写库；agent 客户端零插件，只改 base_url + key
- **部署目标**：Docker VPS（SQLite）
- **使用规模**：个人使用，日均约 1000 条记录

## 开发者命令

```bash
npm run dev                 # 启动开发服务器，访问 http://localhost:3000
npm run build               # 生产构建
npm run lint                # ESLint
npm test                    # vitest 单元测试（src/**/*.test.ts）
npx drizzle-kit studio      # Drizzle Studio（SQLite）

# Docker
docker build -t token-tracker:test .                # 本地构建
cp docker-compose.example.yml docker-compose.yml     # 首次使用：复制示例文件
docker compose up -d                                 # 本地运行
```

## 数据库架构（Drizzle ORM）

- **Schema**：`src/lib/db/schema-sqlite.ts`（sqlite-core）
- **连接配置**：`src/lib/db/index.ts`，懒加载初始化
- **关键配置**：better-sqlite3，文本模式存储时间戳（ISO 格式）
- **自动初始化**：`initDatabase()` 在首次 API 调用时自动建表 + 索引
- **表结构**：
  - `token_records`（id, model, provider, agent, input_tokens, output_tokens, cache_read, cache_write, status, latency_ms, virtual_key_id, created_at）
  - `upstreams`（id, name, protocol, base_url, enabled_models(JSON), priority, enabled, balance, balance_updated_at, created_at）
  - `upstream_keys`（id, upstream_id, api_key_encrypted, enabled, last_status, created_at）
  - `virtual_keys`（id, name, api_key_encrypted, enabled, comment, enabled_models(JSON, 默认 '["*"]'), last_used_at, created_at）
  - `settings`（key TEXT PRIMARY KEY, value TEXT）：`admin_api_key`（AES-256-GCM 加密）、`totp_secret`、`totp_enabled`、`token_epoch`
- **存量迁移**：`migrateColumns()` 泛化支持多表（token_records / virtual_keys / upstreams），通过 `PRAGMA table_info` 检测缺失列并 `ALTER TABLE` 补列（`CREATE TABLE IF NOT EXISTS` 不会补列）

## API 路由与认证

| 路由 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/v1/*`, `/v1beta/*` | 全部 | 虚拟 key（`vk-` 前缀，DB 加密比对） | 代理入口：虚拟 key 校验 → vk model allowlist → model 路由 → 上游 key 故障转移链 → 纯透传 + usage 解析写库 |
| `POST /api/auth/login` | POST | 原始 API key（DB 优先，env 兜底）+ 可选 TOTP | 登录换会话 token（唯一换取入口，内存限流） |
| `/api/dashboard` | GET | 会话 token（`X-API-Key` header） | 聚合统计（total + today + yesterday + daily + models + 365 天 heatmap + 24h 分布） |
| `/api/providers` `/api/models` `/api/agents` `/api/cli` `/api/model-pricing` `/api/records` | GET | 会话 token | 统计/查询 API |
| `/api/admin/upstreams*` | CRUD | 会话 token | 上游管理（含 keys、模型拉取、连接测试、余额刷新） |
| `/api/admin/virtual-keys*` | CRUD | 会话 token | 虚拟 key 管理（创建/编辑/吊销/用量，支持 comment + enabledModels） |
| `/api/admin/auth/totp` `/api/admin/auth/api-key` | CRUD | 会话 token + TOTP 动态码 | TOTP 绑定/解绑、修改登录 key |

- **认证架构（多层防漏）**：验签 middleware（第一层，WebCrypto 验 HMAC 签名 + exp，Edge runtime）→ 路由内 `withAuth`（第二层，epoch 检查 + DB key 指纹校验）→ vitest 静态扫描测试（第三层，`src/lib/auth/guard-scan.test.ts`）→ 本文件约定（第四层）
- **⚠️ breaking change**：所有 `/api/*`（login 除外）只接受会话 token（HMAC-SHA256 签名，GATEWAY_SECRET 派生密钥），**原始 API key 不能直接调 API**。脚本/curl 必须先 `POST /api/auth/login`（body `{apiKey, totpCode?}`）换 token，再带 `X-API-Key: <token>` 调用
- **新增 /api 路由必须用 `withAuth` 包裹**（`src/lib/auth/guard.ts`，login 除外），否则静态扫描测试失败
- **会话 token**：payload 含 `exp + epoch + keyId`；`SESSION_TOKEN_TTL_HOURS` 控制有效期（默认 24h）；认证通过且剩余不足一半时 guard 通过响应头 `X-Session-Token` 下发新 token（滑动续期），`apiFetch` 自动存回 sessionStorage
- **key 生命周期**：修改登录 key（settings 表 `admin_api_key`）时 `token_epoch + 1` → 所有已签发 token 立即 401，env `API_KEYS` 旧 key 立即失效（DB 有 key 时 env 不再被检查）
- **防锁死恢复**：settings 表无 `admin_api_key` 时回退 env `API_KEYS` 兜底；如忘记 key 导致无法登录，删除 `settings` 表中的 `admin_api_key` 行即可恢复（sqlite3 CLI 操作）
- **settings 读写必须包 `withSkipCache()`**（`src/lib/auth/settings.ts`）：查询缓存 TTL 10s，否则改 key/epoch+1/解绑 TOTP 后旧凭证最长残留 10s
- **页面认证**：`/`、`/admin` 由客户端 `ApiKeyGate`（sessionStorage 存会话 token + 401 拦截 + TOTP 两步登录）处理，无 middleware；全局 fetch 走 `src/lib/client/api-client.ts` 的 `apiFetch`
- **TOTP**：RFC 6238 自实现（`src/lib/auth/totp.ts`，30s 窗口 ±1 容差）；admin + dashboard 共用一次登录

## AI Gateway 代理链路（核心）

- **路由**：`src/app/v1/[...path]/route.ts` + `src/app/v1beta/[...path]/route.ts`（`runtime = "nodejs"`、`dynamic = "force-dynamic"`）
- **核心逻辑**：`src/lib/gateway/proxy.ts`（纯逻辑可单测）；依赖注入 `src/lib/gateway/proxy-deps.ts`（DB 访问）
- **流程**：提取虚拟 key（Authorization Bearer / x-api-key / x-goog-api-key / ?key=）→ 校验（**全表解密比对**，AES-256-GCM 随机 IV 无法索引）→ 提取 model（OpenAI/Anthropic 取 body，Gemini 取 path）→ `routeModel()` 匹配（精确 > 前缀通配，priority 小者胜）→ 故障转移链（429/5xx/网络错误重试，每个 key 内 `MAX_RETRY=2`，4xx 直接透传不重试，**流式输出开始后不可重试**）→ 透传（剥离认证头 + `accept-encoding: identity`，按协议注入真实 key）→ 响应管道边透传边累积 → usage 解析器 → `withSkipCache` 写库
- **写库**：仅 2xx 响应记录；响应无 usage 时记 0 且 `status='no_usage'`；`status`/`latency_ms` 为新增列。**口径约定**：`input_tokens` 字段统一按不含 cache_read 写入（OpenAI/Gemini 在 parser 层做减法），`cache_read` 单独列示，展示层 Total Input 含 cache。
- **模型并集**：`GET /v1/models` 返回所有启用上游 `enabled_models` 中非通配条目
- **注意事项**：
  - 新增写入接口必须在写入成功后调用 `invalidateQueryCache()` 或将 handler 包进 `withSkipCache()`（`src/lib/db/cache.ts`）
  - `GATEWAY_SECRET` 缺失时代理路由与 admin API 返回 503，不静默降级
  - 日志永不打印请求 body 与任何 key

### Usage 解析器（`src/lib/gateway/parsers/`）

统一输出 `{inputTokens, outputTokens, cacheRead, cacheWrite, hasUsage}`，按协议选择：

| 字段 | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| input | `usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens` | `usage.input_tokens` | `usageMetadata.promptTokenCount - usageMetadata.cachedContentTokenCount` |
| output | `usage.completion_tokens` | `usage.output_tokens` | `usageMetadata.candidatesTokenCount` |
| cache_read | `prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` | `cachedContentTokenCount` |
| cache_write | 0 | `cache_creation_input_tokens` | 0 |

> **统一口径**：写库字段 `input_tokens` **不含 cache_read**；`cache_read` 单独存储。OpenAI/Gemini 的原生 input 字段含 cache，parser 内部会减去 cache 部分后再写入。Anthropic 的 `input_tokens` 原生已不含 cache，无需减法。
> 展示层 Total Input = `SUM(input_tokens) + SUM(cache_read)`（含 cache），Uncached = `SUM(input_tokens)`，仅单请求（逐条记录）展示区分 uncached / cached。

### 加密（`src/lib/gateway/crypto.ts`）

- AES-256-GCM，密文格式 `iv:authTag:ciphertext`（base64）
- `GATEWAY_SECRET` 支持 hex(64) / base64(32B) / 任意字符串（sha256 派生）
- `generateVirtualKey()`：`vk-` + 32 base64url 随机字符

## 数据处理约定

### 聚合口径
- 展示层所有 **Total Input** 按 `SUM(input_tokens) + SUM(cache_read)` 计算（含 cache）。
- **Uncached Input** = `SUM(input_tokens)`（不含 cache）。
- **Cached Input** = `SUM(cache_read)`（单独列示）。
- 仅单请求（逐条记录 / `/api/records`）展示区分 `Input (Uncached)` 与 `Input (Cached)`；聚合卡片与图表统一展示 Total Input 含 cache，避免重复扣减。

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
- **用途**：Dashboard Top 5 按归一化后的 model 名称聚合

## 查询缓存

- 项目在 **SQLite 驱动层**使用 `lru-cache` 实现了 SELECT 结果缓存，由 `src/lib/db/cache.ts` 管理。
- 通过 `wrapDatabaseClient()` 包装 `better-sqlite3` 的 `prepare` 方法，对 `select`/`pragma`/`with` 语句自动缓存，对其他语句（INSERT/UPDATE/DELETE）自动清空缓存。
- 默认 TTL 10 秒（`API_CACHE_TTL_MS`），时间参数按 10 秒桶取整作为缓存 key，保证同一窗口内查询共享缓存。
- 网关写库（`proxy-deps.ts` 的 `onUsage`/`onComplete`）包进 `withSkipCache()`，INSERT 后自动清缓存，Dashboard 即时可见新数据。

## 时区

- Dashboard 的所有日期/时间分组与显示均按**浏览器时区**对齐。
- `Dashboard.tsx` 通过 `new Date().getTimezoneOffset()` 获取客户端偏移分钟数，并通过 `tzOffset` 查询参数传递给 `/api/dashboard`。
- 服务端使用 `src/lib/timezone-utils.ts` 中的助手函数将 UTC 的 `created_at` 转换为本地日期/小时进行分组和过滤。

## 环境变量

```bash
# SQLite（必需）
SQLITE_DATABASE_PATH="./data/token-tracker.db"

# API Keys（必需）
API_KEYS="your-secret-key"          # 可设置多个，逗号分隔；管理面（Dashboard/admin/统计 API）认证

# AI Gateway 主密钥（必需）
GATEWAY_SECRET=""                   # AES-256-GCM 32 字节（hex/base64）；openssl rand -hex 32

# 可选
HIDDEN_PROVIDERS="openai,google"    # 需要匿名的 provider 列表
MODEL_REGISTRY_PATH=                # model 归一化/价格配置（默认 data/model-registry.json）
SESSION_TOKEN_TTL_HOURS=24          # 会话 token 有效期（小时），默认 24，滑动续期

# Query Cache
API_CACHE_TTL_MS=10000              # SELECT 缓存 TTL（毫秒），默认 10000，0 关闭
API_CACHE_MAX_SIZE=1000             # 缓存最大条目数，默认 1000
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
  -e API_KEYS=your-key-here \
  -e GATEWAY_SECRET=your-32-byte-hex \
  -v /opt/token-tracker/data:/app/data \
  ghcr.io/caibingcheng/token-tracker:latest

# 或用 docker-compose.example.yml（推荐）
cp docker-compose.example.yml docker-compose.yml
docker compose up -d
```

- SQLite 数据库文件在首次 API 请求时由 `initDatabase()` 自动创建（含新表与存量补列），无需手动迁移

### GitHub Container Registry

| 分支 | 镜像标签 | 用途 |
|------|---------|------|
| `master` | `ghcr.io/caibingcheng/token-tracker:latest` | 生产 |
| `dev` | `ghcr.io/caibingcheng/token-tracker:dev` | 测试 |
| 任意 | `ghcr.io/caibingcheng/token-tracker:<sha>` | 指定版本 |

## 测试

- 首次引入 vitest（`src/**/*.test.ts`，`npm test`），测试范围均为不依赖 Next.js 运行时的纯逻辑模块：
  - `src/lib/gateway/parsers/`：三协议 usage 解析
  - `src/lib/gateway/model-router`：精确/通配/priority 匹配、Gemini path 提取
  - `src/lib/gateway/proxy`：认证、故障转移链（mock fetch）、usage 写库回调、vk model allowlist 403
  - `src/lib/gateway/crypto`：AES-256-GCM 往返/篡改
  - `src/lib/auth/totp`：RFC 6238 测试向量 + 时间窗容差
  - `src/lib/auth/session`：会话 token 签发/验签/过期/滑动续期判定
  - `src/lib/auth/edge-verify`：WebCrypto 验签（与 node 侧签名互认）
  - `src/lib/auth/guard-scan`：静态扫描所有 /api 路由必须用 withAuth（login 除外）
  - `src/lib/gateway/balance`：deepseek/openrouter 余额解析（mock fetch）、provider 判定
  - `src/lib/db/migrate`：存量表补列迁移（临时 SQLite 库，幂等性 + NOT NULL 默认值回填）
  - `src/lib/provider-presets`：预设合法性（protocol/baseUrl/唯一性）
  - `src/lib/stats-query`：静态断言聚合口径（Total Input = `SUM(input_tokens) + SUM(cache_read)`；防止 totalInput 回退为纯 `SUM(input_tokens)` 或 totalInputUncached 再次减去 `cache_read`）
- 新增纯逻辑模块（如解析器、路由匹配、加密）时应同步提交单测

## Git Commit

- DO NOT and MUST NOT commit plan/spec files to the repository.
- Commit message must in English.
