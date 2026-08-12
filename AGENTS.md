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
  - `token_records`（id, model, provider, agent, input_tokens, output_tokens, cache_read, cache_write, status, latency_ms, virtual_key_id, request_model, created_at）：**`model` 列 = 发往 upstream 的真实 model 名**（手动路由场景 = targetModel）；`request_model` = 客户端原始请求名（虚拟名路由场景可追溯，仅展示不参与定价）
  - `upstreams`（id, name, protocol, base_url, enabled_models(JSON), priority, enabled, health_check_model, health_status, health_updated_at, balance, balance_updated_at, created_at）
  - `upstream_keys`（id, upstream_id, api_key_encrypted, enabled, last_status, created_at）
  - `upstream_model_health`（upstream_id+model 复合主键, status, expires_at, updated_at）：model 级不可用标记（持久化）
  - `virtual_keys`（id, name, api_key_encrypted, enabled, comment, enabled_models(JSON, 默认 '["*"]'), last_used_at, created_at）
  - `model_prices`（model PRIMARY KEY, input_price, output_price, cache_read_price(NULL→回退 input), cache_write_price(NULL→回退 input), source('models.dev'|'manual'), models_dev_id, updated_at）：官方价参考（USD/1M），**查询时计算**，record 不存价格；`model` = 发往 upstream 的真实名
  - `settings`（key TEXT PRIMARY KEY, value TEXT）：`admin_api_key`（AES-256-GCM 加密）、`totp_secret`、`totp_enabled`、`token_epoch`、`hidden_providers`（明文）、`session_token_ttl_hours`（明文）、`stream_idle_timeout_minutes`（明文）、`status_page_config`（明文 JSON：`{enabled, elements:{total,today,daily,heatmap,hourly,topModels,cost}}`，**默认 enabled=false**）、`model_aliases`（明文 JSON：`[{name, aliases[]}]` 归一化配置，Display pane 编辑）、`totp_fail_count`（明文，TOTP 失败计数）、`totp_locked_until`（明文，TOTP 锁定截止时间戳）、`recovery_codes`（明文 JSON：`{hashes:[sha256...], used:[bool...]}`，只存哈希不存明文）、`recovery_code_login_reminder`（明文，recovery code 登录提醒标记）
- **存量迁移**：`migrateColumns()` 泛化支持多表（token_records / virtual_keys / upstreams），通过 `PRAGMA table_info` 检测缺失列并 `ALTER TABLE` 补列（`CREATE TABLE IF NOT EXISTS` 不会补列）；`migrateTokenRecordsModelColumns()` 专用一次性迁移：`request_model` 回填 = model、`model` 覆盖 = `target_model`（旧 schema）、DROP `target_model`（幂等）

## API 路由与认证

| 路由 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/v1/*`, `/v1beta/*` | 全部 | 虚拟 key（`vk-` 前缀，DB 加密比对） | 代理入口：虚拟 key 校验 → vk model allowlist → model 路由 → 上游 key 故障转移链 → 纯透传 + usage 解析写库 |
| `POST /api/auth/login` | POST | 原始 API key（DB 优先，env 兜底）+ 可选第二因素（TOTP 动态码或 recovery code） | 登录换会话 token（唯一换取入口，可信 IP 限流；key 无效/缺 TOTP/TOTP 错误统一 401 同文案，无 oracle） |
| `GET/POST /api/auth/setup` | GET/POST | 无（fail-open 闸门自校验） | 首次设置向导：GET 探测 `{setupRequired}`；POST 设置初始 admin key + 返回会话 token（仅当 DB 无 key AND env 无 key，限流 + 事务 re-check） |
| `/api/dashboard` | GET | 会话 token（`X-API-Key` header） | 聚合统计（total + today + yesterday + daily + models + 365 天 heatmap + 24h 分布） |
| `/api/providers` `/api/models` `/api/agents` `/api/cli` `/api/model-pricing` `/api/records` | GET | 会话 token | 统计/查询 API |
| `/api/admin/upstreams*` | CRUD | 会话 token | 上游管理（含 keys、模型拉取、连接测试、余额刷新） |
| `/api/admin/virtual-keys*` | CRUD | 会话 token | 虚拟 key 管理（创建/编辑/吊销/用量，支持 comment + enabledModels） |
| `/api/admin/auth/totp` `/api/admin/auth/api-key` `/api/admin/auth/sessions` `/api/admin/auth/recovery-codes` `/api/admin/auth/recovery-codes/reminder` | CRUD | 会话 token + TOTP 动态码 | TOTP 绑定/换绑/解绑、修改登录 key、全局登出（token_epoch+1 吊销全部会话）、recovery codes 查询/重新生成/清除提醒标记 |
| `/api/admin/settings/display` `/api/admin/settings/session` `/api/admin/settings/stream` | GET/PUT | 会话 token | Display tab：HIDDEN_PROVIDERS 分组语法 + 会话 TTL + 流式空闲超时（分钟，settings 表，面板优先） |
| `/api/admin/settings/status` | GET/PUT | 会话 token | Display tab：公开 Status 页配置（status_page_config，`isValidStatusPageConfig` 校验） |
| `/api/admin/settings/aliases` | GET/PUT | 会话 token | Display tab：Model Aliases 归一化配置（model_aliases，`isValidModelAliases` 校验） |
| `/api/admin/model-prices` | GET/PUT/DELETE | 会话 token | 官方价参考管理：GET 行集 = 全部启用 upstream 非通配 enabled_models ∪ 已定价 model（附徽标：active/inactive、待确认/未匹配、有更新+diff、已下架）；PUT 手动编辑（`source='manual'`，清空 models_dev_id）；DELETE 删价（model 走 query，**不用 `[model]` 动态段**，model 名可能含 `/`） |
| `/api/admin/model-prices/candidates?model=X` `/api/admin/model-prices/select` `/api/admin/model-prices/auto-fill` | GET/POST/POST | 会话 token | Price Picker Modal 候选列表（provider、4 价格、预选标记）；从候选选定落库（`source='models.dev'`，价格以快照为准防篡改）；批量填充所有未定价行（只填空不覆盖，manual 行不动） |
| `/api/admin/models-dev/refresh` | POST | 会话 token | 强制刷新 models.dev 快照（失败回退旧快照） |
| `/status` `/status/data` | GET | **无（有意公开）** | 公开用量状态页 + 数据端点：详见下方「公开 Status 页」小节 |

- **认证架构（多层防漏）**：验签 middleware（第一层，WebCrypto 验 HMAC 签名 + exp，Edge runtime）→ 路由内 `withAuth`（第二层，epoch 检查 + DB key 指纹校验）→ vitest 静态扫描测试（第三层，`src/lib/auth/guard-scan.test.ts`，login + setup 白名单）→ 本文件约定（第四层）
- **⚠️ breaking change**：所有 `/api/*`（login、setup 除外）只接受会话 token（HMAC-SHA256 签名，GATEWAY_SECRET 派生密钥），**原始 API key 不能直接调 API**。脚本/curl 必须先 `POST /api/auth/login`（body `{apiKey, totpCode?}`）换 token，再带 `X-API-Key: <token>` 调用
- **新增 /api 路由必须用 `withAuth` 包裹**（`src/lib/auth/guard.ts`，login/setup 除外），否则静态扫描测试失败
- **首次设置向导（唯一 fail-open 入口）**：`src/lib/auth/setup.ts` 的 `canRunSetup()` ⟺ DB 无 `admin_api_key` AND env 无有效 key（`getEnvAdminKeys()` 统一解析）；`runSetup()` 事务内 re-check + 写 key + epoch+1 + 签发 token；middleware matcher 已排除 `auth/setup`；强度 ≥16 字符且 ≥2 字符类别（`isStrongLoginKey`，api-key 修改共用）、独立限流 bucket、审计 `setup_admin_key`
- **会话 token**：payload 含 `exp + epoch + keyId`；TTL 由 `resolveSessionTtlMs()` 决定（settings `session_token_ttl_hours` > env `SESSION_TOKEN_TTL_HOURS` > 默认 24h，只影响新签发 token）；认证通过且剩余不足一半时 guard 通过响应头 `X-Session-Token` 下发新 token（滑动续期），`apiFetch` 自动存回 sessionStorage
- **key 生命周期**：修改登录 key（settings 表 `admin_api_key`）时 `token_epoch + 1` → 所有已签发 token 立即 401，env `ADMIN_API_KEY` 旧 key 立即失效（DB 有 key 时 env 不再被检查）
- **防锁死恢复**：settings 表无 `admin_api_key` 时回退 env `ADMIN_API_KEY` 兜底；如忘记 key 导致无法登录，删除 `settings` 表中的 `admin_api_key` 行即可恢复（sqlite3 CLI 操作）
- **settings 读写必须包 `withSkipCache()`**（`src/lib/auth/settings.ts`）：查询缓存 TTL 10s，否则改 key/epoch+1/解绑 TOTP 后旧凭证最长残留 10s
- **限流 IP 来源**：`src/lib/net/client-ip.ts` 的 `getRateLimitKey()` 统一取值 —— `TRUSTED_PROXY=true` 时取 `x-real-ip`（回退 XFF 末位，反代追加的真实 IP）；默认 false 时忽略全部客户端可控头，退化为全局桶（不可伪造，防 XFF 绕过；代价是攻击者可阻塞登录窗口，但无法爆破）。`extractClientInfo`（审计展示用）只取可信 IP，原始 XFF 存 `xffRaw` 仅供排查
- **页面认证**：`/`、`/admin` 由客户端 `ApiKeyGate`（sessionStorage 存会话 token + 401 拦截 + 本地两步登录：先 key 后 TOTP，第二步触网，未启用 TOTP 留空即可）处理，无 middleware；全局 fetch 走 `src/lib/client/api-client.ts` 的 `apiFetch`
- **TOTP**：RFC 6238 自实现（`src/lib/auth/totp.ts`，30s 窗口 ±1 容差）；admin + dashboard 共用一次登录；暴力防护 `src/lib/auth/totp-lock.ts`（连续 5 次失败锁 15min，之后每 5 次翻倍封顶 24h，计数持久化 settings 表防重启清零，成功清零；锁定期间本人也无法登录，sqlite3 删除 `totp_locked_until` 行恢复；login 与 admin TOTP 绑定/解绑/改 key 共用）
- **换绑**：已启用 TOTP 时生成新 pending 必须带 `currentCode`（旧 secret 验证，失败 `recordTotpFailure()` 计入锁定计数）；换绑成功 `bumpTokenEpoch()` 吊销全部会话（首次启用**不**吊销，保持登录立即展示恢复码）；解绑成功同步 `clearRecoveryCodes()`。⚠️ **前端时序**：换绑成功后 SecuritySettings **不得**再发任何 API 请求（token 已失效会 401 提前踢人，recovery codes 弹窗来不及展示），应仅展示弹窗，关闭弹窗时提示会话已吊销并调 `notifyUnauthorized()` 跳登录
- **Recovery codes**（`src/lib/auth/recovery-codes.ts`）：格式 `XXXX-XXXX-XXXX-XXXX`，字符集排除 `0/O/I/1`；每次生成 4 个一次性码，存储**只存 SHA-256 哈希 + used 标记**（JSON），明文仅在生成成功响应返回一次；登录分流 `classifySecondFactorInput`（6 位纯数字 → TOTP；归一化 16 位 → recovery；其余 → TOTP 分支必然失败）；recovery 验证**绕过 TOTP 锁定**、失败**不计入** `totp_fail_count`（走 login 全局限流桶）、成功清除锁定计数 + 写 `recovery_code_login_reminder='1'`；login 响应带 `viaRecoveryCode: true`，ApiKeyGate 弹 alert，Security 面板显示黄色横幅（「我已检查」DELETE reminder 路由清除）；重新生成（POST recovery-codes）需当前 TOTP 验证，**不**吊销会话；GET 返回 `{remaining, reminder, exists}`（exists 区分「从未生成」黄横幅与「全部用完」红横幅）

### 公开 Status 页（`/status` + `/status/data`）

- **唯一有意公开的用量端点**：位于 `/status` 下（**不是 `/api` 下**），middleware matcher（`/api/*`）天然不匹配，auth 四层防漏零改动；guard-scan 扫描范围外
- **fail-closed**：`status_page_config.enabled` 默认 false（未保存 = 关闭），`/status`（server component `notFound()`）与 `/status/data` 均返回 404；必须 admin panel Display tab 显式开启
- **数据面最小化**（`src/lib/status-query.ts`）：只接受 `tzOffset`（-720..720），无任何过滤参数；按启用元素**按需查询**（`executeStatsQuery` 固定参数），cost/topModels 关闭时**跳过全部 model 级查询**，响应不含模型名/provider 名/成本数据；topModels 开启时复用 hidden_providers 匿名化
- **元素联动**：hourly 依赖 daily，hourly 开启时 `resolveStatusElements` 强制 daily=true；topModels 开启时隐式返回成本字段（TopModelsCards 组件固定显示 cost）
- **60s 响应级 LRU 缓存**（key=tzOffset，max 50）：整包缓存不感知写库，故 60s 滞后可接受；`setStatusPageConfig()` 主动调 `invalidateStatusCache()` 立即失效
- **限流**：`checkStatusRateLimit()`（status-query.ts 导出，60 req/min 固定窗口，`getRateLimitKey()` 取 key），与 setup/login 同款内存 bucket 模式
- **⚠️ 两处 route 必须 `dynamic = "force-dynamic"`**（`/status/page.tsx` + `/status/data/route.ts`）：否则构建期预渲染会把 enabled/disabled 决策烘焙进产物
- **配置**：`parseStatusPageConfig` 逐 key 与默认值合并（非法 JSON/字段回退默认，返回全新对象不污染共享默认）；PUT 校验 `isValidStatusPageConfig`（enabled + 全部 7 元素 boolean，未知 key 拒绝）

## AI Gateway 代理链路（核心）

- **路由**：`src/app/v1/[...path]/route.ts` + `src/app/v1beta/[...path]/route.ts`（`runtime = "nodejs"`、`dynamic = "force-dynamic"`）
- **核心逻辑**：`src/lib/gateway/proxy.ts`（纯逻辑可单测）；依赖注入 `src/lib/gateway/proxy-deps.ts`（DB 访问；session/health 为**模块级单例**，因 `createProxyDeps()` 每请求创建）
- **流程**：path `..` 段净化（`sanitizePathSegments`，逃逸出 base 前缀 → 400）→ 提取虚拟 key（Authorization Bearer / x-api-key / x-goog-api-key / ?key=）→ 校验（**全表解密比对**，AES-256-GCM 随机 IV 无法索引）→ 提取 model（OpenAI/Anthropic 取 body，Gemini 取 path；**长度上限 256**）→ `routeModelByProtocol()` 取候选（精确 > 前缀通配，priority 小者胜，协议过滤）→ **跨 upstream 故障转移链**（session 粘性 binding 优先 → 其余 healthy 候选按 priority；每个 upstream 内遍历 key、每个 key 内 `MAX_RETRY=2`，**401/403 认证错误不重试直接换 key/upstream 并触发 failover**，其余 4xx 直接透传不重试、不触发 failover，**3xx 重定向一律视为失败（`redirect: "manual"`，防上游 key 跨源泄露）**，**流式输出开始后不可重试**；某 upstream 全部 key 失败标记 unhealthy 并继续下一个）→ 透传（剥离认证头 + 客户端可控源信息头 + `accept-encoding: identity`，按协议注入真实 key）→ 响应管道边透传边增量解析 usage → `withSkipCache` 写库
- **Session 粘性**：`src/lib/gateway/session.ts` — `sessionId = sha256(system 拼接尾部 1024 + 首条 user 文本前 1024 + model + vkId + protocol)`；内存 LRU（max 5000 / ttl 24h），仅 failover 落点 ≠ 默认 upstream 时保存 binding；binding 失效条件：upstream 被禁用/无 key/协议不匹配/不 healthy/不再匹配 model（链过滤自动覆盖）；单候选跳过 session 计算
- **健康状态**：`src/lib/gateway/health.ts`（内存缓存 + **DB 持久化**：upstream 级存 `upstreams.health_status`，model 级存 `upstream_model_health`，重启后懒加载恢复探活调度）+ `src/lib/gateway/probe.ts`（非流式小请求探活，不记 token）；**upstream 级** healthy → unhealthy：真实请求中全部 key 失败（401 认证失败触发；403/404 为 model 级，不误伤）；unhealthy 不进入候选池，30 分钟定时探活恢复（`upstreams.health_check_model` 优先，否则 `enabled_models` 第一个非通配，无则保持 unhealthy）；**model 级**：某 upstream 对该 model 返回 404/403（全部 key）时标记该 model 不可用（TTL 30 分钟自动恢复），路由时跳过该 upstream 并 failover，UI 模型列表显示 unavailable 徽标；**手动测试（`/api/admin/upstreams/[id]/test-model|test-all-models`）成功即立即恢复健康状态（markHealthy + markModelHealthy），404/403 失败立即标记**，不依赖 30 分钟探活；**全部 unhealthy 时直接 502 不尝试**
- **写库**：仅 2xx 响应记录；响应无 usage 时记 0 且 `status='no_usage'`；`status`/`latency_ms` 为新增列。**口径约定**：`input_tokens` 字段统一按不含 cache_read 写入（OpenAI/Gemini 在 parser 层做减法），`cache_read` 单独列示，展示层 Total Input 含 cache。**model 列写真实名**（路由重写时用 targetModel，否则用请求名），原始请求名写 `request_model`（虚拟名路由可追溯）。
- **流式 usage 增量解析**：`proxy.ts` 透传时用 `StreamUsageExtractor`（`parsers/stream-usage.ts`）边读边解析，只保留首尾 usage 小对象，**不持有完整响应体**（内存 O(1)）；流式空闲超时默认 30min，由 settings 表 `stream_idle_timeout_minutes` 配置（Display tab，无 env），超时中断流并释放连接。非流式仍整包缓冲（JSON.parse 需要完整 body）。
- **模型并集**：`GET /v1/models` 返回所有启用上游 `enabled_models` 中非通配条目
- **注意事项**：
  - 新增写入接口必须在写入成功后调用 `invalidateQueryCache()` 或将 handler 包进 `withSkipCache()`（`src/lib/db/cache.ts`）
  - `GATEWAY_SECRET` 缺失时代理路由与 admin API 返回 503，不静默降级（`proxy-deps.ts` 的 `GatewaySecretMissingError` 向上传播，不再吞错降级 401/502）
  - 请求体上限默认 32MB（`GATEWAY_MAX_BODY_MB` 可调，超限 413）；非流式响应整包缓冲上限 50MB（超限中断，流式路径 O(1) 不受影响）
  - 502/协议不匹配错误不回显内部细节（upstream 名、内网地址等），仅进服务端日志
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
- **数据源**：settings 表 `hidden_providers`（admin panel Display tab 编辑，面板优先）→ env `HIDDEN_PROVIDERS` fallback → 空。**面板保存后 env 被静默忽略**，UI 有提示
- **唯一 async 入口**：`loadHiddenProviderGroups()`（settings 优先 → env 回退）；纯函数一律接收 `groups` 参数显式传参（`anonymizeProvider` / `resolveProviderFilter` / `deanonymizeProvider` / `parseHiddenProviderGroups`），不直接读 env
- **分组语法**：分号分组的通配匹配，如 `CustomA:vendor*`；被隐藏的 provider 在 UI 显示为 "Provider A", "Provider B"... 或自定义名称
- **缓存失效**：`setHiddenProvidersSetting` 写入时调用 `invalidateModelCache()` 清空 `normalizeModel` 的 `rawToCanonical`，面板改分组后立即生效
- **相关文件**：`src/lib/provider-utils.ts`、`src/lib/model-registry.ts`（`isProviderHidden`）

### 官方价参考（`model_prices` + models.dev）

- **语义**：价格 = 官方价参考（非真实账单），**查询时计算**（record 不存价格/cost），`src/lib/pricing.ts` 的 `loadPriceMap()` 读全表（cache 价 NULL 回退 input_price，内存缓存）
- **定价键**：一律按真实 model 名（`model_prices.model` = 发往 upstream 的真实名）；归一化 alias 仅作展示层 roll up 分组键；虚拟名（`request_model`）仅追溯，不参与定价
- **成本链路**：`stats-query.ts` 在 model/date-model 分组输出行上按真实名附加 `cost`（`computeModelCost`，未定价 → 全 0）→ 归一化聚合时随行合并（`mergeAggregatedCosts`）；未定价 model 成本为 0，补价后历史立即重算
- **写接口**：`/api/admin/model-prices` PUT/DELETE、select、auto-fill、aliases 均须 `withSkipCache()` + `invalidatePriceCache()`（pricing.ts 内存缓存）；价格变更后 Dashboard/Status 立即反映
- **models.dev 集成**（`src/lib/models-dev/`，纯逻辑可单测）：数据源 `https://models.dev/api.json`（USD/1M）；本地快照 `data/models-dev-cache.json`（`{fetchedAt, data}`），**懒刷新 7 天 TTL**（访问时超期则本次用旧快照、后台异步拉新）+ `POST /api/admin/models-dev/refresh` 强制刷新，拉取失败静默回退旧快照
- **匹配管线**（`match.ts`）：精确 → 归一化（小写去 `-_.`）→ 日期变体剥离（`-\d{8}$`）；多 provider 冲突按内置原厂优先级表自动预选（anthropic > openai > google > deepseek > ...），价格相同不视为冲突，全部候选供 Price Picker Modal 切换
- **自动填充**（`auto-fill.ts`）：只填空行、永不覆盖已有价格，`source='manual'` 的行永不被自动流程触碰；触发点：upstream 保存 enabled_models 后（best-effort）+ auto-fill API 批量填充
- **徽标判定**（`src/lib/model-prices-service.ts`）：`active`（在任一 enabled_models）/`inactive`（已定价但已移除，价格保留供历史）；`待确认`（未定价且多候选价格不一致）/`未匹配`（未定价无候选）；`有更新`（models.dev 来源且快照同 id 价格不同，带 diff）/`已下架`（models.dev 来源且快照无该 id）

### Model 归一化
- **文件**：`src/lib/model-registry.ts`（纯归一化模块，不加载任何文件；`src/lib/model-utils.ts` 仅做薄封装）
- **数据源**：settings 表 `model_aliases`（Display pane 编辑）→ `loadModelAliases()`（与 `loadHiddenProviderGroups()` 同模式，调用方先 await 再注入）；**MODEL_REGISTRY_PATH / model-registry.json 已废弃删除**
- **规则**（按优先级依次匹配）：1. 精确匹配规则 `name` → 2. 精确匹配 `aliases` 中的 `provider/model` 别名 → 3. 若 provider 被 `HIDDEN_PROVIDERS` 隐藏，只按 `model` 部分匹配 → 4. 精确匹配 `model` 别名 → 5. 未命中保持原始名称
- **缓存失效**：`setModelAliasesSetting` / `setHiddenProvidersSetting` 写入时调 `invalidateModelCache()` 清空 `rawToCanonical` + `invalidateQueryCache()`
- **用途**：Dashboard Top 5 按归一化后的 model 名称聚合；Status 页只显示归一化名（alias）

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

# AI Gateway 主密钥（必需）
GATEWAY_SECRET=""                   # AES-256-GCM 32 字节（hex/base64）；openssl rand -hex 32

# 可选：bootstrap（未配置且 DB 无 key 时 Web 端出现首次设置向导）
# ADMIN_API_KEY="your-secret-key"   # 可设置多个，逗号分隔；旧名 API_KEYS 兼容（deprecated）

# 可选：也可在 admin panel Display tab 配置（面板优先，env 仅 fallback）
HIDDEN_PROVIDERS="openai,google"    # 需要匿名的 provider 列表（分组语法）
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

| 分支 | 镜像标签 | 用途 |
|------|---------|------|
| `master` | `ghcr.io/caibingcheng/token-tracker:latest` | 生产 |
| `dev` | `ghcr.io/caibingcheng/token-tracker:dev` | 测试 |
| 任意 | `ghcr.io/caibingcheng/token-tracker:<sha>` | 指定版本 |

## 移动端适配约定

- 任何 UI 改动必须同时考虑移动端（<768px）：新表格必须做「桌面 table + `md:hidden` 卡片」双轨；
  新弹窗移动端全屏（`w-full h-full md:...`）；新导航/按钮触摸区 ≥40px；input 移动端字号 ≥16px
- 移动端专属 UI 一律 `md:hidden` 门控，桌面端 DOM 只新增不修改
- 复用现有范式：RecordsTable 双轨、ActionMenu、FiltersModal、PriceSimulatorModal
- 提交前自检：375px 视口无横向溢出，桌面端视觉无回归

## 测试

- 首次引入 vitest（`src/**/*.test.ts`，`npm test`），测试范围均为不依赖 Next.js 运行时的纯逻辑模块：
  - `src/lib/gateway/parsers/`：三协议 usage 解析（含 `stream-usage` 增量提取：随机 chunk 边界对照批量 parser、多行 data、跨 chunk 事件、UTF-8 截断）
  - `src/lib/gateway/model-router`：精确/通配/priority 匹配、Gemini path 提取
  - `src/lib/gateway/proxy`：认证、跨 upstream 故障转移链 + session 粘性（mock fetch）、usage 写库回调、vk model allowlist 403
  - `src/lib/gateway/session`：会话指纹提取（截断/多 system/多模态/无 user）+ hash 稳定性 + LRU binding store
  - `src/lib/gateway/health`：健康状态机（失败 → unhealthy → 探活成功 → healthy、失败重调度、幂等）
  - `src/lib/gateway/crypto`：AES-256-GCM 往返/篡改
  - `src/lib/auth/totp`：RFC 6238 测试向量 + 时间窗容差
  - `src/lib/auth/recovery-codes`：生成格式/互斥/字符集、SHA-256 哈希、验证+标记已用（重复失败）、归一化、剩余数量递减、提醒标记往返、classifySecondFactorInput 分流
  - `src/app/api/admin/auth/totp/route.test`：TOTP 路由集成测试（临时 SQLite + 真实 handler + 签名 token）：换绑无 currentCode → 400、错误计入 totp_fail_count、换绑成功替换 secret + token_epoch+1、首次启用 epoch 不变、解绑清理 recovery_codes/reminder
  - `src/lib/auth/session`：会话 token 签发/验签/过期/滑动续期判定
  - `src/lib/auth/edge-verify`：WebCrypto 验签（与 node 侧签名互认）
  - `src/lib/auth/guard-scan`：静态扫描所有 /api 路由必须用 withAuth（login 除外）
  - `src/lib/gateway/balance`：deepseek/openrouter 余额解析（mock fetch）、provider 判定
  - `src/lib/db/migrate`：存量表补列迁移（临时 SQLite 库，幂等性 + NOT NULL 默认值回填）+ `migrateTokenRecordsModelColumns`（request_model 回填、model 覆盖 target_model、DROP、幂等）
  - `src/lib/models-dev/match`：三级匹配管线（精确/归一化/日期变体剥离）、多候选冲突按优先级预选、价格相同不视为冲突
  - `src/lib/models-dev/auto-fill`：只填空不覆盖、manual 行不动、未匹配跳过
  - `src/lib/pricing`：loadPriceMap cache 价 NULL 回退 input + 内存缓存/失效、computeModelCost
  - `src/lib/model-registry`：注入 aliases 的归一化各优先级规则、缓存失效、getDisplayName、isValidModelAliases/parseModelAliases
  - `src/app/api/admin/model-prices/route.test`：Admin API 集成测试（临时 SQLite + 真实 handler + 签名 token）——GET 行集与徽标状态（active/inactive/待确认/未匹配/有更新/已下架）、PUT 手动编辑（source='manual' 清空 modelsDevId、model 名含 `/`）、DELETE、select 落库、auto-fill 只填空不覆盖 manual 行、未带 withAuth 401
  - `src/lib/provider-presets`：预设合法性（protocol/baseUrl/唯一性）
  - `src/lib/gateway/url-guard`：上游 baseUrl SSRF 防护（环回/私有/链路本地/元数据 IP 拒绝、DNS 解析后分类、ALLOW_PRIVATE_UPSTREAMS 逃生开关）
  - `src/lib/gateway/url-utils`：`joinUrlPath` 前缀去重 + `sanitizePathSegments` `..` 段净化（逃逸返回 null）
  - `src/lib/net/client-ip`：限流 IP 可信源（TRUSTED_PROXY 开关、XFF 伪造防护）
  - `src/lib/auth/totp-lock`：TOTP 失败计数 + 指数锁定（settings 表持久化，防重启清零）
  - `src/lib/stats-query`：静态断言聚合口径（Total Input = `SUM(input_tokens) + SUM(cache_read)`；防止 totalInput 回退为纯 `SUM(input_tokens)` 或 totalInputUncached 再次减去 `cache_read`）+ 日期过滤必须直比较（sargable，防 strftime 套列导致索引失效）
  - `src/lib/timezone-utils`：`localDateKeyToUtcStartISO` 时区换算（含互逆 round-trip）
  - `src/lib/auth/settings-status`：status_page_config 默认值合并（fail-closed、非法 JSON/字段回退、不污染共享默认）+ 合法性校验
  - `src/lib/status-query`：元素联动（hourly→daily）+ 按需查询断言（cost/topModels 关闭不执行 model 级查询）+ 响应裁剪（不泄露模型名）+ 响应缓存失效 + 60 req/min 限流
- 新增纯逻辑模块（如解析器、路由匹配、加密）时应同步提交单测

## Git Commit

- DO NOT and MUST NOT commit plan/spec files to the repository.
- Commit message must in English.
