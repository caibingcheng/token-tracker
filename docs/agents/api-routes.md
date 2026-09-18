# API 路由与认证

> 上级文档：`AGENTS.md`。新增/修改 `/api/*` 路由前必读。

| 路由 | 方法 | 认证 | 说明 |
|------|------|------|------|
| `/v1/*`, `/v1beta/*` | 全部 | 虚拟 key（`vk-` 前缀，DB 加密比对） | 代理入口：虚拟 key 校验 → vk model allowlist → model 路由 → 上游 key 故障转移链 → 纯透传 + usage 解析写库 |
| `POST /api/auth/login` | POST | 原始 API key（DB 优先，env 兜底）+ 可选第二因素（TOTP 动态码或 recovery code） | 登录换会话 token（唯一换取入口，可信 IP 限流；key 无效/缺 TOTP/TOTP 错误统一 401 同文案，无 oracle） |
| `GET/POST /api/auth/setup` | GET/POST | 无（fail-open 闸门自校验） | 首次设置向导：GET 探测 `{setupRequired}`；POST 设置初始 admin key + 返回会话 token（仅当 DB 无 key AND env 无 key，限流 + 事务 re-check） |
| `/api/dashboard` | GET | 会话 token（`X-API-Key` header） | 聚合统计（total + today + yesterday + daily + models + 365 天 heatmap + 24h 分布） |
| `/api/providers` `/api/models` `/api/agents` `/api/cli` `/api/records` | GET | 会话 token | 统计/查询 API —— `/api/agents` 默认返回**派生工具名**列表（按 `user_agent` 解析，NULL UA 追加 `(unknown)`），`?dimension=key` 保留旧行为（distinct `agent` 列 + hidden vk 过滤，供 DisplaySettings vk 建议列表 `?dimension=key&includeHidden=1`）；`/api/records` 行 `agent` = 派生工具名、`keyName` = `agent` 列原值（vk 名） |
| `/api/model-pricing` | GET | 会话 token | 已定价模型行集（PriceSimulatorModal 下拉数据源，附带 models.dev 归一化索引推断的 `provider` 分组字段 + `providers` 全量列表）；`?provider=<id>` 返回该 provider 的 models.dev 全部模型（懒加载数据源）；`?search=<q>` 切换为快照全量搜索模式（`searchModelsDevModel` 全量收集 + 相关性排序再截断 50：provider 名精确命中 > modelId 精确 > 归一化精确 > 前缀 > 子串，同级按原厂优先级表，保证原厂不被聚合平台挤出）；models.dev 来源 canonicalId = `providerId/modelId`，cache 价缺失回退 input，快照缺失返回空数组；仿真只读不落库 |
| `/api/admin/upstreams*` | CRUD | 会话 token | 上游管理（含 keys、模型拉取、连接测试、余额刷新；可配 HTTP CONNECT 代理 `proxy_url`，`validateProxyUrl` SSRF 校验，写后仅回显脱敏 host；test-connection/fetch-models 复用 SSRF 校验，私网/环回地址 400；`headerTransforms` 出站 header 变换全量替换，`isValidHeaderTransforms` 仅格式校验——header token 字符集/禁 CRLF/≤4KB/≤20 条，无语义黑名单，`normalizeHeaderTransforms` 落库前 header 名小写化；GET 行数据带健康字段 `unhealthy`/`modelUnhealthy`/`probe`（探活状态内存态，从未探测 null）；PATCH `enabled` 联动探活启停，DELETE 联动清探活内存态与 `upstream_model_health` 残留行） |
| `/api/admin/upstreams/[id]/probe` | POST | 会话 token | 手动 Probe now：立即探活并返回最新 `ProbeStatus`（不要求 enabled、不记审计，与 test-model 同口径）；upstream 不存在 404 |
| `/api/admin/virtual-keys*` | CRUD | 会话 token | 虚拟 key 管理（创建/编辑/吊销/用量，支持 comment + enabledModels + max_rpm/max_tpm/max_daily_tokens/max_monthly_tokens 配额） |
| `/api/admin/models` | GET | 会话 token | Admin Models 面板数据源：路由模拟（手动/自动解析到具体 upstream + model）+ 已解析模型列表 |
| `/api/admin/routing-rules*` | CRUD | 会话 token | 手动路由规则管理（虚拟名 + protocol → upstream + target_model + priority，`UNIQUE(name, protocol, upstream_id, target_model)` 同名多目标 failover 链（同 upstream 可挂不同 targetModel）；PATCH 仅编辑 priority/targetModel，upstream 改动词 = 删旧建新，审计 `routing_rule_updated`） |
| `/api/admin/audit-logs` | GET | 会话 token | 管理操作审计日志（分页查询，action/actor/target_type 过滤） |
| `/api/admin/auth/totp` `/api/admin/auth/api-key` `/api/admin/auth/sessions` `/api/admin/auth/recovery-codes` `/api/admin/auth/recovery-codes/reminder` | CRUD | 会话 token + TOTP 动态码 | TOTP 绑定/换绑/解绑、修改登录 key、全局登出（token_epoch+1 吊销全部会话）、recovery codes 查询/重新生成/清除提醒标记 |
| `/api/admin/settings/display` | GET/PUT | 会话 token | Display tab：hidden_providers 分组（settings 唯一来源，无 env fallback） |
| `/api/admin/settings/hidden-sources` | GET/PUT | 会话 token | Display tab：Hidden Sources 配置（`hidden_sources`，`isValidHiddenSources` 校验；GET/PUT 均包 `withSkipCache`） |
| `/api/admin/settings/session` `/api/admin/settings/stream` | GET/PUT | 会话 token | Security tab：会话 TTL + 流式空闲超时（分钟，settings 表，面板优先） |
| `/api/admin/settings/status` | GET/PUT | 会话 token | Display tab：公开 Status 面板配置（status_page_config，`isValidStatusPageConfig` 校验） |
| `/api/admin/settings/aliases` | GET/PUT | 会话 token | Display tab：Model Aliases 归一化配置（model_aliases，`isValidModelAliases` 校验） |
| `/api/admin/settings/agent-aliases` | GET/PUT | 会话 token | Display tab：Agent Aliases 派生映射配置（agent_aliases，`isValidAgentAliases` 校验；PUT 审计 `agent_aliases_updated`；**GET 返回 `{rules, observed}`**——observed = 数据库已出现 UA token 的解析结果（token→name + source manual/builtin/as-is，NULL UA 不进列表），驱动面板只读展示） |
| `/api/admin/settings/models-dev-source` | GET/PUT | 会话 token | Models 面板：快照数据源开关（`models_dev_source`，`isValidModelsDevSource` 校验；PUT 仅写开关**不触发拉取**，下次 Refresh/懒刷新按新源；GET 返回 `{source, snapshotSource}`——快照实际来源，过渡期可与开关不一致供 UI 提示） |
| `/api/admin/model-prices` | GET/PUT/DELETE | 会话 token | 官方价参考管理：GET 行集 = 全部启用 upstream 非通配 enabled_models ∪ 已定价 model ∪ 推送记录出现过的 model（附徽标：active/inactive、待确认/未匹配、有更新+diff、已下架）；PUT 手动编辑（`source='manual'`，清空 models_dev_id）；DELETE 删价（model 走 query，**不用 `[model]` 动态段**，model 名可能含 `/`） |
| `/api/admin/model-prices/candidates?model=X` `/api/admin/model-prices/candidates?q=...` `/api/admin/model-prices/select` `/api/admin/model-prices/auto-fill` | GET/POST/POST | 会话 token | Price Picker Modal 候选列表（provider、4 价格、预选标记；`q` = 搜索模式，全量扫描快照不限匹配管线）；从候选选定落库（`source` 取当前快照源即 models.dev/github，校验 modelsDevId 存在于快照即可，价格以快照为准防篡改——搜索选中的条目与自动匹配等价）；批量填充（POST body `{mode?}`：`"fill"` 缺省只填空不覆盖 / `"force"` 覆盖所有非 manual 已定价行即 Re-fill all；manual 行永不被自动流程触碰） |
| `/api/admin/models-dev/refresh` | POST | 会话 token | 强制刷新快照（失败回退旧快照；按 `models_dev_source` 开关用 models.dev 或 Litellm 源，审计含 `source`） |
| `/api/admin/models-dev/upload` | POST | 会话 token | 手动上传快照（**格式自动识别**：api.json 原文 / `{fetchedAt,data}` 包装 / Litellm `model_prices_and_context_window.json`——后者自动转换为 models.dev 结构并标记 `source='github'`；body ≤10MB、provider ≤1000、model ≤50k，`sanitizeModelsDevData` 丢弃结构/数值非法条目并返回 `dropped` 计数（**cost 缺失的无价条目保留**，官方 api.json 含无价模型），全非法 400；`uploadSnapshot` 更新内存缓存 + 落盘，**无需重启**；审计 `models_dev_upload` 含 `source`） |
| `/ingest/records` | POST | **ingest token（`it-` 前缀，Bearer）** | 多实例同步接收端点（位于 /api 之外，middleware 天然不拦）：详见 `docs/agents/sync.md` |
| `/api/admin/ingest-tokens` `/api/admin/ingest-tokens/[id]` `/api/admin/ingest-tokens/[id]/unbind` | CRUD/POST | 会话 token | A 侧 ingest token 管理：列表/创建（创建返回一次明文 `it-` + 32 base64url；**列表可回显明文供随时复制**，与 virtual_keys 惯例一致）/PATCH 启停改名/DELETE 吊销/unbind 解绑（清空 bound_uid，下次推送重新 TOFU）；审计 `ingest_token_*` |
| `/api/admin/sync-instances` `/api/admin/sync-instances/[uid]` | GET/DELETE | 会话 token | A 侧实例水位查看/删除（list 返回 `uid` + `instanceName`，重名可区分；DELETE 路由参数 = **uid**（`u-[a-f0-9]{32}`）；`?deleteRecords=1` 级联删除该实例已推送历史记录——`remote_instance_uid = uid AND virtual_key_id = -1` 等值匹配 + **OR 上 uid 为 NULL 旧行的 `provider LIKE 'remote/{instance_name}/%'` 前缀兼容兜底**（哨兵双保险防误删本地记录），默认保留，删记录后 `invalidateStatusCache()`；先查水位存在否则 404 不动记录）；审计 `sync_instance_deleted` 含 `{uid, instanceName, deleteRecords, deletedRecords}` |
| `/api/admin/sync/config` | GET/PUT/DELETE | 会话 token | B 侧同步配置：GET 脱敏回显 token + 回显 uid；PUT 校验 URL/instance 格式 + token 加密落库 + `withSkipCache`；instance 为纯展示名随时可改（**无绑定锁定**，身份键是 uid）；审计 `sync_config_updated`。DELETE 清除推送配置（凭证 + bound_uid + last_error/attempt，pushes 立即停止），**cursor/epoch/uid/instance/last_success 保留**（重配同 A 从原游标恢复不重复；改配其他 A 需先 Reset 否则历史缺口），幂等 no-op，审计 `sync_config_deleted` 含 cursor/droppedCount 快照 |
| `/api/admin/sync/status` | GET | 会话 token | B 侧推送状态：cursor/待推送数（`[cursor+1, maxId]` 非 -1）/maxRecordId/droppedCount/uid/boundUid/lastSuccessAt/lastError/lastAttemptAt/lastSkippedInvalid——丢失可观测；GET 同时 arm 60s 兜底轮询（`syncPusher.kick()`，未配置零开销） |
| `/api/admin/sync/trigger` | POST | 会话 token | 手动触发推送一轮（`SyncPusher.trigger()`）；审计 `sync_triggered` |
| `/api/admin/sync/skip` | POST | 会话 token | 手动跳过：body `{upToRecordId}` 必须 > 当前游标，强制推进游标丢弃区间 + dropped_count 累计 + 审计 `sync_skip` |
| `/api/admin/sync/reset` | POST | 会话 token | 重置同步状态：游标归零 + 重新生成 epoch + 解除本地锁定（A 重建场景，纯本地）；dropped_count 保留；审计 `sync_reset` |
| `/status/data` | GET | **无（有意公开）** | 公开用量数据端点：详见下方「公开 Status 面板」小节 |

- **认证架构（多层防漏）**：验签 middleware（第一层，WebCrypto 验 HMAC 签名 + exp，Edge runtime）→ 路由内 `withAuth`（第二层，epoch 检查 + DB key 指纹校验）→ vitest 静态扫描测试（第三层，`src/lib/auth/guard-scan.test.ts`，login + setup 白名单）→ `AGENTS.md` 约定（第四层）
- **⚠️ breaking change**：所有 `/api/*`（login、setup 除外）只接受会话 token（HMAC-SHA256 签名，GATEWAY_SECRET 派生密钥），**原始 API key 不能直接调 API**。脚本/curl 必须先 `POST /api/auth/login`（body `{apiKey, totpCode?}`）换 token，再带 `X-API-Key: <token>` 调用
- **新增 /api 路由必须用 `withAuth` 包裹**（`src/lib/auth/guard.ts`，login/setup 除外），否则静态扫描测试失败
- **首次设置向导（唯一 fail-open 入口）**：`src/lib/auth/setup.ts` 的 `canRunSetup()` ⟺ DB 无 `admin_api_key` AND env 无有效 key（`getEnvAdminKeys()` 统一解析）；`runSetup()` 事务内 re-check + 写 key + epoch+1 + 签发 token；middleware matcher 已排除 `auth/setup`；强度 ≥16 字符且 ≥2 字符类别（`isStrongLoginKey`，api-key 修改共用）、独立限流 bucket、审计 `setup_admin_key`
- **会话 token**：payload 含 `exp + epoch + keyId`；TTL 由 `resolveSessionTtlMs()` 决定（settings `session_token_ttl_hours` > env `SESSION_TOKEN_TTL_HOURS` > 默认 24h，只影响新签发 token）；认证通过且剩余不足一半时 guard 通过响应头 `X-Session-Token` 下发新 token（滑动续期），`apiFetch` 自动存回 sessionStorage
- **key 生命周期**：修改登录 key（settings 表 `admin_api_key`）时 `token_epoch + 1` → 所有已签发 token 立即 401，env `ADMIN_API_KEY` 旧 key 立即失效（DB 有 key 时 env 不再被检查）
- **防锁死恢复**：settings 表无 `admin_api_key` 时回退 env `ADMIN_API_KEY` 兜底；如忘记 key 导致无法登录，删除 `settings` 表中的 `admin_api_key` 行即可恢复（sqlite3 CLI 操作）
- **settings 读写必须包 `withSkipCache()`**（`src/lib/auth/settings.ts`）：查询缓存 TTL 10s，否则改 key/epoch+1/解绑 TOTP 后旧凭证最长残留 10s
- **限流 IP 来源**：`src/lib/net/client-ip.ts` 的 `getRateLimitKey()` 统一取值 —— `TRUSTED_PROXY=true` 时取 `x-real-ip`（回退 XFF 末位，反代追加的真实 IP）；默认 false 时忽略全部客户端可控头，退化为全局桶（不可伪造，防 XFF 绕过；代价是攻击者可阻塞登录窗口，但无法爆破）。`extractClientInfo`（审计展示用）只取可信 IP，原始 XFF 存 `xffRaw` 仅供排查
- **页面认证**：`/`、`/admin` 由客户端 `ApiKeyGate`（sessionStorage 存会话 token + 401 拦截 + 本地两步登录：先 key 后 TOTP，第二步触网，未启用 TOTP 留空即可）处理，无 middleware；未登录时先渲染公开面板（`/status/data` 404 则纯登录门，详见「公开 Status 面板」）；全局 fetch 走 `src/lib/client/api-client.ts` 的 `apiFetch`
- **TOTP**：RFC 6238 自实现（`src/lib/auth/totp.ts`，30s 窗口 ±1 容差）；admin + dashboard 共用一次登录；暴力防护 `src/lib/auth/totp-lock.ts`（连续 5 次失败锁 15min，之后每 5 次翻倍封顶 24h，计数持久化 settings 表防重启清零，成功清零；锁定期间本人也无法登录，sqlite3 删除 `totp_locked_until` 行恢复；login 与 admin TOTP 绑定/解绑/改 key 共用）
- **换绑**：已启用 TOTP 时生成新 pending 必须带 `currentCode`（旧 secret 验证，失败 `recordTotpFailure()` 计入锁定计数）；换绑成功 `bumpTokenEpoch()` 吊销全部会话（首次启用**不**吊销，保持登录立即展示恢复码）；解绑成功同步 `clearRecoveryCodes()`。⚠️ **前端时序**：换绑成功后 SecuritySettings **不得**再发任何 API 请求（token 已失效会 401 提前踢人，recovery codes 弹窗来不及展示），应仅展示弹窗，关闭弹窗时提示会话已吊销并调 `notifyUnauthorized()` 跳登录
- **Recovery codes**（`src/lib/auth/recovery-codes.ts`）：格式 `XXXX-XXXX-XXXX-XXXX`，字符集排除 `0/O/I/1`；每次生成 4 个一次性码，存储**只存 SHA-256 哈希 + used 标记**（JSON），明文仅在生成成功响应返回一次；登录分流 `classifySecondFactorInput`（6 位纯数字 → TOTP；归一化 16 位 → recovery；其余 → TOTP 分支必然失败）；recovery 验证**绕过 TOTP 锁定**、失败**不计入** `totp_fail_count`（走 login 全局限流桶）、成功清除锁定计数 + 写 `recovery_code_login_reminder='1'`；login 响应带 `viaRecoveryCode: true`，ApiKeyGate 弹 alert，Security 面板显示黄色横幅（「我已检查」DELETE reminder 路由清除）；重新生成（POST recovery-codes）需当前 TOTP 验证，**不**吊销会话；GET 返回 `{remaining, reminder, exists}`（exists 区分「从未生成」黄横幅与「全部用完」红横幅）

## 公开 Status 面板（`/` 未登录态 + `/status/data`）

- **页面并入 Dashboard**：公开面板渲染在 `/` 未登录分支（`ApiKeyGate` 三态：`hasKey=null` 空白 → `gateView='public'` 渲染 `PublicStatusView` → 404 后 `gateView='login'` 纯登录门）；`/status` 页面路由已删除；`/status/data` 数据端点保留
- **唯一有意公开的用量端点**：`/status/data` 位于 `/status` 下（**不是 `/api` 下**），middleware matcher（`/api/*`）天然不匹配，auth 四层防漏零改动；guard-scan 扫描范围外
- **fail-closed**：`status_page_config.enabled` 默认 false（未保存 = 关闭），`/status/data` 返回 404，前端探测到 404 渲染纯登录门；必须 admin panel Display tab 显式开启
- **数据面最小化**（`src/lib/status-query.ts`）：只接受 `tzOffset`（-720..720），无任何过滤参数；按启用元素**按需查询**（`executeStatsQuery` 固定参数），cost/topModels 关闭时**跳过全部 model 级查询**，响应不含模型名/provider 名/成本数据；topModels 开启时复用 hidden_providers 匿名化
- **隐私裁剪**（公开端点专属，`/api/dashboard` 不受影响）：total 不下发 `firstActiveAt`/`lastActiveAt`（实时活跃信号，公开页前端零引用）；单价类 `costPerMillion*` 一律不下发（防定价表泄露——注意查询层 `StatItem.cost` 是完整 `AggregatedCost`，展开 spread 会把内嵌单价带进响应，`buildModelStat`/total 组装必须**显式重建**），只保留 `totalCost`；前端共享组件（StatsCards/TodayOverview/DailyUsageChart）新增 `costDetail` prop（默认 true），公开页传 `false` 隐藏单价明细（价格线 / 1M 列 / Input·Cache·Output Cost 列），Dashboard 行为不变
- **元素联动**：hourly 依赖 daily，hourly 开启时 `resolveStatusElements` 强制 daily=true；topModels 开启时隐式返回成本字段（TopModelsCards 组件固定显示 cost）
- **60s 响应级 LRU 缓存**（key=tzOffset，max 50）：整包缓存不感知写库，故 60s 滞后可接受；`setStatusPageConfig()` 主动调 `invalidateStatusCache()` 立即失效
- **限流**：`checkStatusRateLimit()`（status-query.ts 导出，60 req/min 固定窗口，`getRateLimitKey()` 取 key），与 setup/login 同款内存 bucket 模式
- **⚠️ `/status/data/route.ts` 必须 `dynamic = "force-dynamic"`**：否则构建期预渲染会把 enabled/disabled 决策烘焙进产物
- **配置**：`parseStatusPageConfig` 逐 key 与默认值合并（非法 JSON/字段回退默认，返回全新对象不污染共享默认）；PUT 校验 `isValidStatusPageConfig`（enabled + 全部 7 元素 boolean，未知 key 拒绝）
