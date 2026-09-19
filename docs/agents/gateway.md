# AI Gateway 代理链路（核心）

> 上级文档：`AGENTS.md`。改 `/v1/*` `/v1beta/*` 代理链路前必读。

- **路由**：`src/app/v1/[...path]/route.ts` + `src/app/v1beta/[...path]/route.ts`（`runtime = "nodejs"`、`dynamic = "force-dynamic"`）
- **核心逻辑**：`src/lib/gateway/proxy.ts`（纯逻辑可单测）；依赖注入 `src/lib/gateway/proxy-deps.ts`（DB 访问；session/health 为**模块级单例**，因 `createProxyDeps()` 每请求创建）
- **手动路由（完全替代自动路由）**：`findRoutingRules()` 命中 `name+protocol` 规则组 → 目标 = 各 rule 的 upstream + target_model，按 priority 升序（同 priority 按 id）构成多目标 failover 链；禁用/不存在的目标跳过并记日志，无有效目标 → 502 `manual_route_unavailable`；健康目标排链首、unhealthy / model 级不可用目标排尾（兜底），兜底 2xx 走统一自愈（degradedUpstreams 集合 + markHealthy/markModelHealthy）；body/path 改写 **per-hop 按当跳目标计算**（OpenAI/Anthropic 改 body.model、Gemini 改 path 模型段），写库 model = 成功落点目标的真实名，响应 model 回写虚拟名；链 >1 时 session 粘性自动生效；同名自动路由完全失效（UI 标注 `overridden`）
- **流程**：path `..` 段净化（`sanitizePathSegments`，逃逸出 base 前缀 → 400）→ 提取虚拟 key（Authorization Bearer / x-api-key / x-goog-api-key / ?key=）→ 校验（**全表解密比对**，AES-256-GCM 随机 IV 无法索引）→ 提取 model（OpenAI/Anthropic 取 body，Gemini 取 path；**长度上限 256**）→ `routeModelByProtocol()` 取候选（精确 > 前缀通配，priority 小者胜，协议过滤）→ **配额检查**（`checkQuota`，`src/lib/gateway/quota.ts`：max_rpm/max_tpm/max_daily_tokens/max_monthly_tokens 任一超限 → 429 `quota_exceeded`，不转发上游）→ **跨 upstream 故障转移链**（session 粘性 binding 优先 → 其余 healthy 候选按 priority；每个 upstream 内遍历 key、每个 key 内 `MAX_RETRY=2`，**401/403 认证错误不重试直接换 key/upstream 并触发 failover**，其余 4xx 直接透传不重试、不触发 failover，**3xx 重定向一律视为失败（`redirect: "manual"`，防上游 key 跨源泄露）**，**流式输出开始后不可重试**；某 upstream 全部 key 失败标记 unhealthy 并继续下一个；**无健康候选时兜底**：自动路由/手动路由/responses 辅助端点均在全部候选不健康时回退尝试 unhealthy 候选（不留 502），**兜底拿到 2xx 立即 markHealthy + markModelHealthy 自愈**）→ 透传（剥离认证头 + 客户端可控源信息头 + `accept-encoding: identity`，按协议注入真实 key）→ 响应管道边透传边增量解析 usage → `withSkipCache` 写库
- **Session 粘性**：`src/lib/gateway/session.ts` — `sessionId = sha256(system 拼接尾部 1024 + 首条 user 文本前 1024 + model + vkId + protocol)`；内存 LRU（max 5000 / ttl 24h），仅 failover 落点 ≠ 默认 upstream 时保存 binding；binding 失效条件：upstream 被禁用/无 key/协议不匹配/不 healthy/不再匹配 model（链过滤自动覆盖）；单候选跳过 session 计算
- **健康状态**：`src/lib/gateway/health.ts`（内存缓存 + **DB 持久化**：upstream 级存 `upstreams.health_status`，model 级存 `upstream_model_health`，重启后懒加载恢复探活调度）+ `src/lib/gateway/probe.ts`（非流式小请求探活，不记 token）；**upstream 级** healthy → unhealthy：真实请求中全部 key 失败（401 认证失败触发；403/404 为 model 级，不误伤）；unhealthy 不进入候选池（**仅当存在健康候选时**），30 分钟定时探活恢复（`upstreams.health_check_model` 优先，否则 `enabled_models` 第一个非通配，无则保持 unhealthy）；**探活全 key 链**：`probeUpstream` 用 `probeModelWithKeys` 逐个 key 探测（与真实请求/手动 test-model 同口径），任一 key 成功即恢复；**404 放宽**：全部 key 均 403/404（`sawModelError && !sawAuthError`，上游可达 + key 有效，仅探测 model 被下架/改名）→ 视为 upstream 级恢复，**401 不放宽**；探活恢复时顺带 `markModelHealthy` 清**被探测的那个 model** 的标记（与兜底自愈「清当跳 model」口径对齐）；**探活状态内存态**（`ProbeStatus`：lastAt/ok/status/error/nextAt，零 schema 变更，重启后显示「未探测」），`GET /api/admin/upstreams` 行数据带 `probe` 字段（从未探测 null），UI unhealthy 徽标旁展示上次探活结果 + 下次倒计时 + **Probe now** 按钮（`POST /api/admin/upstreams/[id]/probe`，不要求 enabled、不记审计，与 test-model 手动测试同口径；`HealthTracker.probeNow` in-flight 互斥防并发重入）；**生命周期联动**：PATCH `enabled=false` → `stopProbing`（停 timer 清 nextAt，保留 unhealthy DB 状态供 UI 展示与重新启用恢复）；PATCH `enabled=true` 且 unhealthy → `resumeProbing` + 立即探活（fire-and-forget 不阻塞响应）；DELETE → `removeUpstream`（清 timer/内存态/model 标记）+ 清 `upstream_model_health` 残留行；重启 `load()` 的 `loadUpstreams` SQL 带 `enabled = 1` 过滤（禁用的 unhealthy 不挂 timer）；**探活范围只测一个 model**：upstream 级故障是连通性/key 级，任一 model 探通即证恢复，model 级故障走 `upstream_model_health` TTL 通道不依赖探活；**model 级**：某 upstream 对该 model 返回 404/403（全部 key）时标记该 model 不可用（TTL 30 分钟自动恢复），路由时跳过该 upstream 并 failover，UI 模型列表显示 unavailable 徽标；**无健康候选时兜底**：全部候选不健康也按 priority 尝试（含手动路由目标 unhealthy 不再 502），**兜底拿到 2xx 立即 markHealthy + markModelHealthy 自愈**（真实请求成功是强恢复信号）；**手动测试（`/api/admin/upstreams/[id]/test-model|test-all-models`）成功即立即恢复健康状态（markHealthy + markModelHealthy），404/403 失败立即标记**，不依赖 30 分钟探活；**自定义探活端点**（`upstreams.probe_config`，JSON `{path, body}`，`src/lib/gateway/probe-config.ts`）：配置存在时探活 / Test / Probe now 只打该端点**一次**（不补发第二种风格，显式即真相），body 支持 `{{model}}` 替换，path 必须是相对路径，拒绝绝对 URL / `//` 开头 / 含 `..` 的段 / `?`、`#`（会把后续内容变成 query/fragment，使 `..?x=1` 这类段绕开段检查）/ 百分号编码与反斜杠等等价形式（它们会被 URL 解析归一化成点段或分隔符，从而逃出 baseUrl 前缀；path ≤1024，body JSON ≤8192）；构造请求时还会用 WHATWG URL 归一化后复核一遍不变量（仍在 baseUrl 路径前缀内），不符则回落默认双风格——黑名单无法穷举等价写法，这层是兜底；空值或非法值一律**静默回落默认 chat → responses 双风格**，存量 upstream 行为不变（仅读取路径静默，不阻塞流量）；写入侧 POST/PATCH 接受 `probeConfig` 对象、PATCH `null` 清除，非法值 400。用途：非 chat 端点（`/v1/systemone`、`/v1/embeddings` 等）以前会被默认 chat 基线探成 404 并误标 model 级不可用，配了就不会；UI 表单提供 chat / responses / embeddings / systemone 预置一键填入；注意它是 **upstream 级**，chat 与 embedding 模型混用需拆两条同 base_url 条目
- **写库**：仅 2xx 响应记录；响应无 usage 时记 0 且 `status='no_usage'`；`status`/`latency_ms` 为新增列。**口径约定**：`input_tokens` 字段统一按不含 cache_read 写入（OpenAI/Gemini 在 parser 层做减法），`cache_read` 单独列示，展示层 Total Input 含 cache。**model 列写真实名**（路由重写时用 targetModel，否则用请求名），原始请求名写 `request_model`（虚拟名路由可追溯）。
- **流式 usage 增量解析**：`proxy.ts` 透传时用 `StreamUsageExtractor`（`parsers/stream-usage.ts`）边读边解析，只保留首尾 usage 小对象，**不持有完整响应体**（内存 O(1)）；流式空闲超时默认 30min，由 settings 表 `stream_idle_timeout_minutes` 配置（Security tab，无 env），超时中断流并释放连接。非流式仍整包缓冲（JSON.parse 需要完整 body）。
- **模型并集**：`GET /v1/models` 返回所有启用上游 `enabled_models` 中非通配条目
- **注意事项**：
  - 新增写入接口必须在写入成功后调用 `invalidateQueryCache()` 或将 handler 包进 `withSkipCache()`（`src/lib/db/cache.ts`）
  - `GATEWAY_SECRET` 缺失时代理路由与 admin API 返回 503，不静默降级（`proxy-deps.ts` 的 `GatewaySecretMissingError` 向上传播，不再吞错降级 401/502）
  - 请求体上限默认 32MB（`GATEWAY_MAX_BODY_MB` 可调，超限 413）；非流式响应整包缓冲上限 50MB（超限中断，流式路径 O(1) 不受影响）
  - 502/协议不匹配错误不回显内部细节（upstream 名、内网地址等），仅进服务端日志
  - **管理端旁路 fetch 同样 `redirect: "manual"`**：`fetchUpstreamModels`（upstream-client.ts）、探活 `probeOnce`（probe.ts）、余额 `fetchBalance`（balance.ts）均带真实 key 访问第三方上游，3xx 一律视为失败（防 key 经跨源重定向被动泄露），与主代理链路 `proxy.ts` 口径一致
  - **Upstream 级 HTTP CONNECT 代理（`proxy_url`）**：仅 `http://`/`https://` 代理（undici `ProxyAgent`），CONNECT 隧道 TLS 端到端，API key 对代理不可见；`proxy_url_encrypted` 走 AES-256-GCM 加密落库（写后不可读，GET/审计仅回显脱敏 `scheme://host[:port]`）；六处出站 fetch（主链、responses 辅助链、probe、fetchUpstreamModels、fetchBalance）统一 `...(dispatcher ? { dispatcher } : {})` 注入（`src/lib/gateway/proxy-dispatcher.ts`，模块级 Map 缓存 `ProxyAgent`，上限 50）；`validateProxyUrl` 复用 `isPrivateIpv4/6` + DNS 全地址私网拒绝 + `ALLOW_PRIVATE_UPSTREAMS` 逃生（公网代理无需开）；模型级粒度用「同 base_url 拆两个 upstream 条目」组合实现；代理不可用时 CONNECT 失败走现有重试/换 key/标记 unhealthy 逻辑
  - test-connection / fetch-models 管理端点与 upstream 创建/更新共用 `validateUpstreamBaseUrl` SSRF 校验（私网/环回/元数据地址 400），不用裸 `^https?://` 正则
  - 日志永不打印请求 body 与任何 key

## Usage 解析器（`src/lib/gateway/parsers/`）

统一输出 `{inputTokens, outputTokens, cacheRead, cacheWrite, hasUsage}`，按协议选择：

| 字段 | OpenAI | Anthropic | Gemini |
|---|---|---|---|
| input | `usage.prompt_tokens - usage.prompt_tokens_details.cached_tokens` | `usage.input_tokens` | `usageMetadata.promptTokenCount - usageMetadata.cachedContentTokenCount` |
| output | `usage.completion_tokens` | `usage.output_tokens` | `usageMetadata.candidatesTokenCount` |
| cache_read | `prompt_tokens_details.cached_tokens` | `cache_read_input_tokens` | `cachedContentTokenCount` |
| cache_write | 0 | `cache_creation_input_tokens` | 0 |

> **统一口径**：写库字段 `input_tokens` **不含 cache_read**；`cache_read` 单独存储。OpenAI/Gemini 的原生 input 字段含 cache，parser 内部会减去 cache 部分后再写入。Anthropic 的 `input_tokens` 原生已不含 cache，无需减法。
> 展示层 Total Input = `SUM(input_tokens) + SUM(cache_read)`（含 cache），Uncached = `SUM(input_tokens)`，仅单请求（逐条记录）展示区分 uncached / cached。

## 加密（`src/lib/gateway/crypto.ts`）

- AES-256-GCM，密文格式 `iv:authTag:ciphertext`（base64）
- `GATEWAY_SECRET` 支持 hex(64) / base64(32B) / 任意字符串（sha256 派生）
- `generateVirtualKey()`：`vk-` + 32 base64url 随机字符
