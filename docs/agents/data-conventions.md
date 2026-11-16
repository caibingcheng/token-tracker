# 数据与统计约定

> 上级文档：`AGENTS.md`。改统计口径 / 聚合 / 定价 / 归一化 / 匿名化 / 时区前必读。

## 聚合口径
- **全部记录一律计入聚合**：聚合统计不再支持按 upstream / vk 名剔除（原 Hidden Sources 功能已删除）；要排除某些记录只能删除它们，或依靠筛选（`provider`/`model`/`agent` 参数做 inclusion）。settings 表遗留的 `hidden_sources` 行代码不读不写，仅存量查阅
- 展示层所有 **Total Input** 按 `SUM(input_tokens) + SUM(cache_read)` 计算（含 cache）。
- **Uncached Input** = `SUM(input_tokens)`（不含 cache）。
- **Cached Input** = `SUM(cache_read)`（单独列示）。
- 仅单请求（逐条记录 / `/api/records`）展示区分 `Input (Uncached)` 与 `Input (Cached)`；聚合卡片与图表统一展示 Total Input 含 cache，避免重复扣减。
- `status` 列语义见下表，值集合以 `src/lib/gateway/proxy.ts` 为准（不新增状态前先与实现对齐）；估算兜底的字符口径细节见 `gateway.md` 的「写库」条目，两处必须一致：

| `status` | 触发条件 | token / cache 口径 | RecordsTable 徽标 | 计入聚合 |
|---|---|---|---|---|
| `NULL` | 2xx、解析到上游 usage 且未标记中断（流式与非流式均适用） | 全部取上游真值：`input_tokens`（不含 cache）、`cache_read`、`cache_write`、`output_tokens` | `-` | 是，真实用量 |
| `estimated` | 2xx、未解析到 usage、响应 body 已完整读完（`responseComplete`）且未标记中断；估算 `input + output > 0` | `input_tokens` 按请求 `messages` / `contents`（responses 风格 `input`）JSON 序列化估算；`output_tokens` 非流式取 assistant 文本、流式取 `StreamUsageExtractor.contentTokens`；`cache_read` / `cache_write` 恒为 0 | `Estimated` | 是，计入聚合与派生成本，但非真实用量 |
| `no_usage` | 2xx、未解析到 usage、且未进入估算分支（估算 `input + output == 0`，或响应未完整读完） | 全 0 | `No usage` | 是（不贡献数值） |
| `client_aborted` | 客户端中途断开（`cancel()` / abort 信号），且未 `responseComplete`、未 `sawTerminal` | 已解析到 usage 则写真值，否则全 0；**不进入估算** | `Client aborted` | 是 |
| `stream_interrupted` | 上游流中断 / 流式空闲超时（pump 抛错且非客户端主动断开） | 同上 | `Stream interrupted` | 是 |
| `classifier` | 命名路由 LLM 分类器决策的独立记录（`src/lib/gateway/classifier/`），分类器失败也记 | 分类器返回的 usage，失败或无 usage 时全 0；`cache_read` / `cache_write` 恒为 0 | `Classifier` | 是，计入成本 |

表外三条必须记住的：

- `estimated` 与 `no_usage` 的分流条件是「估算 `input + output` 是否 > 0」，不是「流式 vs 非流式」——两种都可能落到任一状态。
- `client_aborted` / `stream_interrupted` 永不进入估算分支：估算的 output 可能缺尾部，残缺值写进统计比 `no_usage` 更差。已收到协议终止事件（`[DONE]` / `response.completed` / `message_stop`）或非流式读完后的客户端断开不算中断；Gemini 流无终止事件，仍可能误标 `client_aborted`。
- `classifier` 行同时是一条真实记录：`model` = 分类器真实名，`request_model` = 虚拟名。

聚合不因 status 剔除任何行。

## Dashboard 视图
- **多维筛选**（`src/components/MultiSelect.tsx`，Dashboard 与 Records 共用）：Agent / Provider / Model 三个下拉支持搜索、复选、Select all（作用于当前搜索结果）、Clear；空选 = 不筛选（等价旧 `all`）。选中值以**重复 query 参数**传递（`?agent=a&agent=b`），服务端 `parseFilterValues()`（`src/lib/filter-params.ts`）过滤空串与 `all` 并去重；每个维度按**去重前**的原始参数计数，值数 ≤100、单值 ≤128 字符，单值链接向后兼容。超限或任一名未命中均 →400，后者在错误信息中列出该维度未命中的名字。解析→SQL 条件：Provider/Model 由 `resolveProviderFilters` / `resolveNormalizedModelFilters`（带手动 model aliases，与 `/api/records` 一致）逐名解析取并集；Agent 由 `resolveAgentUserAgentsMulti` 取 UA 并集，多选时 `unknown` 与具体 agent 可同时命中（`buildAgentUaWhereClause` 生成 `OR(user_agent IS NULL, user_agent IN (...))`）
- `src/components/UsageHeatmap.tsx`：头部 GitHub 风格 365 天使用热力图，按 input + output tokens 分档着色，移动端横向滚动。
- `src/components/DailyUsageChart.tsx`：N 日使用趋势 + “Last N Days” 汇总卡片，其中第 5 张卡片展示 24 小时平均分布直方图（纯 CSS 柱）。
- `src/components/StatsCards.tsx` / `TodayOverview.tsx` / `TopModelsCards.tsx`：其余统计卡片。
- `src/components/DailyUsageChart.tsx`（Speed section，`SpeedTable`）：延迟统计消费层，`/api/dashboard` 响应的 `latency` 字段（byModel + daily）驱动。

## 延迟统计（`src/lib/latency-query.ts`）
- **数据源**：`token_records.latency_ms`（全部请求）+ `ttft_ms`（仅流式，非流式 NULL）；范围跟随 Dashboard dailyRange，日期过滤 sargable（`localDateKeyToUtcStartISO` 直比较，复用 stats-query 的 `buildWhereClause`）
- **byModel**：按归一化 model × provider 分组，输出 count / streamCount / avgTtftMs / p50TtftMs（仅流式行）/ avgLatencyMs（全部行）/ outputTokensPerSec（仅流式且 latency > ttft 的行，防除零）；**只保留 active model**（当前启用 upstream 非通配 enabled_models 并集，`loadActiveModelSet()` 与 model_prices 的 active 判定同源，已删除 model 不显示）；按 p50 升序排（快者在前，无样本排最后）
- **daily**：按浏览器时区日期分组（`aggregateLatencyDaily`），全量历史不过滤 active；无流式样本的日期不产出行
- **p50 口径**：`percentile()` 线性插值；avg/p50 四舍五入为整数 ms，tok/s 保留 1 位小数
- **展示**：Speed 对比表并入 Trends 区块（桌面 table + `md:hidden` 卡片）+ Daily p50 TTFT 折线图（recharts LineChart，与其余 Daily 图表共用 `syncId="daily"` 联动、点击选中日期；无流式样本日期断线，整区间无流式数据不渲染）；RecordsTable 单条记录显示 TTFT + Latency 独立两列（`formatLatencyMs` 统一 `xxxms` 格式，无值显示 `-`）
- **Records 页宽度**：内容区全宽（`w-full`，不再 `max-w-7xl` 居中），10 列 + 侧栏收起时铺满屏幕
- **Records Tokens 列**（id `tokens`，口径同 LiteLLM/Langfuse 单列）：单元格 `in / out · xx% cached`，`in = input_tokens + cache_read`（Total Input 口径）、`xx% = cache_read / in`（in 为 0 不显示括号段），数值跟随 123 / K/M/B 全局格式；hover title 展开明细（Prompt 合计 + uncached + cached + Cache rate 一位小数 + Output，均千分位）；移动端卡片点开明细后展示同一套数值（无 hover）。原 `Input (Uncached)` / `Input (Cached)` / `Output` 三列已合并，存量 `records_columns` 里的 `input`/`cacheRead`/`output` id 读取时归一到 `tokens`
- **Records Model 列**：只显示原始名（`model` 列 = 发往 upstream 的真实名），hover title 才显示 `Manual: <归一化展示名>`（仅与原始名不同时）+ `Raw: <原始名>` + `Requested: <客户端原始请求名>`（仅与原始名不同时）；移动端卡片同规则：卡片上只显示原始名，`Manual` / `Requested` 进展开明细（移动端无 hover）
- **Records 列可见性**：`src/lib/records-columns.ts` 定义 10 列（id/label）与默认全显示，用户选择的可见列 id 存 settings `records_columns`（Records 页 Columns 下拉切换，即时 PUT，失败回退上一次值）；**只存集合不存顺序**（展示顺序恒按定义序，无拖拽），至少保留一列（前端禁用最后一个勾选框 + 服务端拒绝空数组）；桌面 table 与 `md:hidden` 卡片同源过滤，未显示列仍由 API 返回（不做响应裁剪）
- **Audit 列可见性**：同一套机制（`src/lib/audit-columns.ts` 7 列 + settings `audit_columns` + `ColumnPicker` 共享组件），Audit 页筛选/分页/列选交互与 Records 一致：Action 下拉（选项来自 `/api/admin/audit-logs` 返回的 `actions` 去重列表）、Rows 20/50/100/200、分页器卡内（first/prev/页码输入/next/last）；无自动刷新（审计日志低频）
- **注意**：TTFT = 首个 SSE chunk 到达时间，个别上游先推空 chunk 会略微低估真实首 token 时间，对比用途足够

## Provider 匿名化
- **数据源**：settings 表 `hidden_providers`（admin panel Display tab 编辑，唯一来源，未保存 → 空；无 env fallback，与 model_aliases 语义一致）
- **唯一 async 入口**：`loadHiddenProviderGroups()`（settings 单一来源）；纯函数一律接收 `groups` 参数显式传参（`anonymizeProvider` / `resolveProviderFilter` / `deanonymizeProvider` / `parseHiddenProviderGroups`），不直接读 env
- **分组语法**：分号分组的通配匹配，如 `CustomA:vendor*`；被隐藏的 provider 在 UI 显示为 "Provider A", "Provider B"... 或自定义名称
- **Provider 维度归并**：同一组内多个真实 provider 在 Provider 维度统计中合并为一行（Top Providers、每日堆叠图、Speed/latency 表），由 `providerGroupKey()` 计算聚合键；组名同时作为 `ProviderStat.provider` 与 `ProviderStat.providerName`，保证前端堆叠图跨日 series 连续；Model 维度仍按归一化 model 名独立聚合，不受影响
- **缓存失效**：`setHiddenProvidersSetting` 写入时调用 `invalidateModelCache()` 清空 `normalizeModel` 的 `rawToCanonical`，面板改分组后立即生效
- **相关文件**：`src/lib/provider-utils.ts`（`providerGroupKey`、`anonymizeProvider`、`resolveProviderFilter`）、`src/lib/model-registry.ts`（`isProviderHidden`）

## 官方价参考（`model_prices` + models.dev）

- **语义**：价格 = 官方价参考（非真实账单），**查询时计算**（record 不存价格/cost），`src/lib/pricing.ts` 的 `loadPriceMap()` 读全表（cache 价 NULL 回退 input_price，内存缓存）
- **定价键**：一律按真实 model 名（`model_prices.model` = 发往 upstream 的真实名）；归一化 alias 仅作展示层 roll up 分组键；虚拟名（`request_model`）仅追溯，不参与定价
- **成本链路**：`stats-query.ts` 在 model/date-model 分组输出行上按真实名附加 `cost`（`computeModelCost`，未定价 → 全 0）→ 归一化聚合时随行合并（`mergeAggregatedCosts`）；未定价 model 成本为 0，补价后历史立即重算
- **Price Simulation**（`src/lib/price-simulation.ts`，纯逻辑 + `simulatePricing`）：只试算不写库；数据范围独立于 dashboard 过滤（弹窗内 Agent/Provider/Model 自行拉 `/api/dashboard?range=30d`，打开时仅同步 Dashboard 中恰好单选的 Agent/Provider/Model，多选或未选的维度回退 `all`（弹窗内筛选仍为单选））；调整 cache rate 时 **Total Input 不变**，只在 cached / uncached 之间重分配（cacheWrite / output 不受影响），缺省跟随各区间实际 `cache_read / total_input`；单价可手改（空/非法/负值回退官方价）；展示层 Cache rate = `cache_read / total_input`
- **写接口**：`/api/admin/model-prices` PUT/DELETE、select、auto-fill、aliases 均须 `withSkipCache()` + `invalidatePriceCache()`（pricing.ts 内存缓存）；价格变更后 Dashboard 立即反映
- **models.dev 集成**（`src/lib/models-dev/`，纯逻辑可单测）：**双数据源** —— `https://models.dev/api.json`（USD/1M）+ GitHub LiteLLM `model_prices_and_context_window.json`（raw.githubusercontent 主源，jsDelivr CDN 回退；per-token → ×1e6 换算 USD/1M，`sample_spec` 剔除、`litellm_provider` 空/非字符串跳过、无 token 价条目保留为无价条目、batch/reasoning 细分价不取）；两源各自解析器统一输出 `ModelsDevData`，下游零感知；本地快照 `data/models-dev-cache.json`（`{fetchedAt, source, data}`），**单一当前快照语义**（文件 + 内存缓存不拆分，谁最后成功谁是当前快照；旧文件缺 `source` 字段回退 `"models.dev"` 零迁移），**懒刷新 7 天 TTL**（访问时超期则本次用旧快照、后台异步拉新）+ `POST /api/admin/models-dev/refresh` 强制刷新 + `POST /api/admin/models-dev/upload` 手动上传（`uploadSnapshot` 内存缓存 + 落盘立即生效；`sanitizeModelsDevData` 仅上传路径严格校验，非法条目丢弃）；拉取失败静默回退旧快照；**数值信任链兜底**：`isFiniteNonNegative`（有限非负）守卫贯穿 `toCandidate` 与 select 落库，所有快照来源（网络/手工文件/上传）的负数/NaN 价格均回退 0/null，防成本计算污染；**in-flight 竞态对策**：`runRefresh` 同源复用 promise、异源等待 settle 后串行发起（写盘顺序 = 发起顺序，无乱序覆盖）
- **匹配管线**（`match.ts`）：精确 → 归一化（小写去 `-_.`）→ 日期变体剥离（`-\d{8}$`）；多 provider 冲突按内置原厂优先级表自动预选（anthropic > openai > google > deepseek > ...），**有价候选（hasCost）恒优先于无价候选**（冲突判定与排序均纳入 hasCost，价格相同但 hasCost 不同也算冲突），同级内价格相同不视为冲突，全部候选供 Price Picker Modal 切换。候选集 = 名字命中的条目，**不含同系列不同名**；需要非匹配条目时用 Price Picker 搜索（`searchModelsDevModel`：model id / provider 名归一化子串匹配，上限 50）——搜索选中落库后与自动匹配完全等价（`source='models.dev'` + modelsDevId，hasUpdate/removed 检测照常）
- **自动填充**（`auto-fill.ts`）：双模式契约——**fill 模式**（缺省）只填空行、永不覆盖已有价格；**force 模式**（`overwrite:true` + `isManual` 保护集）覆盖所有非 manual 已定价行（结果 `updated` 计数），**无价条目（见下行）不覆盖、计入 `unmatched`**；`source='manual'` 的行永不被任何自动流程触碰；触发点：upstream 保存 enabled_models 后（best-effort，只填空）+ auto-fill API 批量填充（`{mode:"fill"|"force"}`）
- **已知限制**（litellm 源）：embedding 模型仅 input 价 → output=0；jsDelivr 缓存滞后 / 超 20MB 拒载（litellm JSON 现约 2-3MB 安全）；litellm 候选搜索噪声（bedrock/azure 变体多，由匹配管线 & Price Picker 消解）
- **徽标判定**（`src/lib/model-prices-service.ts`）：**行集** = 全部启用 upstream 非通配 `enabled_models` ∪ 已定价 model ∪ 本机记录 ∪ 推送记录出现过的 model（本机 = `remote_instance_uid` NULL 且 provider 非 `remote/` 前缀，与推送严格互补；全历史可发现、可补价，默认可见性仍由 active ∪ 近 30 天流量决定）；`active`（在任一 enabled_models）/`inactive`（已定价且无任何在用来源且 30 天无流量，价格保留供历史）；`待确认`（未定价且多候选价格不一致）/`未匹配`（未定价无候选）；`有更新`（同源快照同 id 价格不同，带 diff）/`已下架`（同源快照无该 id）/`0 价待确认`（zeroNoPrice：同源快照条目无官方价且已存价含 0，早期 force 覆盖遗留，UI 静态警示徽标，无 action）——**跨源不比较**：快照源（models.dev/github）与价格行来源不一致时一律不判定有更新/已下架（两源 provider/model 命名体系不同，跨源比较必然误报）；**无价条目不列下架**（快照 id 仍在但 cost 缺失，litellm/models.dev 均保留此类条目）；**无价条目不写价**：只有快照条目同时提供 input 与 output 官方价才参与自动写库 / 建议徽标 / accept（谓词 `hasPriceData`，`src/lib/models-dev/match.ts`，显式 0 算有价，只提供其中一个字段 = 无价），无价候选统一计入 `unmatched`；**排序**：`inactive || removed` 行统一排到行集末尾（组内按 model 名 A→Z，桌面表格与移动卡片同序），红 removed 行不额外隐藏（可见性仍由 active ∪ recentActivity 决定；同时为 inactive 的行仍默认隐藏）；行含 `sourceProvider`（自动来源的 provider 显示名，快照缺失回退 providerId；manual 为 null），表格徽标显示 `{models.dev|LiteLLM} · {providerName}`

## Agent 维度派生（Dashboard Agent = 客户端工具名）

- **语义**：`token_records.agent` 列 = **来源 key 名**（本地 vk 名 / 远程 `remote/{instance}/{vk名}`），继续承担同步协议与 ingest 改写（零改动）；Dashboard 的 **Agent 维度显示客户端工具名**（claude-code、opencode 等），由 `user_agent` 列**查询时派生**（不回填、不改历史数据），Records 表 Agent（派生）+ Key（`agent` 列原值）双列展示，另带 Session 列（`session_id`：客户端 header 原值，未携带时回退网关会话指纹；无筛选）
- **解析规则**（`src/lib/agent-utils.ts`，纯逻辑可单测）：UA 首段 token（第一个 `/` 前，lowercase）→ 手动 `agent_aliases` 精确匹配（大小写不敏感）→ 内置 `BUILTIN_AGENT_MAP`（claude-cli→claude-code、codex_cli_rs/codex→codex、geminicli→gemini-cli、aider→aider、cursor-agent→cursor 等）→ 未命中回退 token 本身；null/空 UA → `unknown`（筛选 UI 显示 `(unknown)`）
- **注册新 agent 工具**：无需改代码——在 Display pane Agent Aliases 添加 {name, aliases[]} 即可（多 UA token 可映射同一工具名），写入 `setAgentAliasesSetting` 主动 `invalidateQueryCache()` 立即生效
- **过滤器**：Dashboard/Records 的 `agent` 参数是**派生工具名**，支持重复 query 参数；服务端由 `resolveAgentUserAgentsMulti` 逐名反找并取 UA 并集（空值、上限与 400 语义见上文「多维筛选」）。具体 agent 走 `user_agent IN (...)`，`unknown` 走 `user_agent IS NULL`，二者同选时由 `buildAgentUaWhereClause` 合成 OR。`/api/cli` 不支持维度过滤（`agent`/`provider`/`range` 一律忽略，不解析、不报 400）。`buildWhereClause` 的第 4 参数即此 UA 过滤（类型 `AgentUaFilter`）
- **注意**：反找需 `selectDistinct(user_agent)` 全表扫描（无索引）；个人规模（日均约 1000 行）+ 10s 查询缓存可接受。远程记录（vk=-1）按自身 UA 派生，与本地同名工具合并为一个 agent；instance 区分仍靠 provider 的 `remote/{instance}/` 前缀

## Model 归一化
- **文件**：`src/lib/model-registry.ts`（纯归一化模块，不加载任何文件；`src/lib/model-utils.ts` 仅做薄封装）
- **数据源**：settings 表 `model_aliases`（Display pane 编辑）→ `loadModelAliases()`（与 `loadHiddenProviderGroups()` 同模式，调用方先 await 再注入）；**MODEL_REGISTRY_PATH / model-registry.json 已废弃删除**
- **规则**（按优先级依次匹配）：1. 精确匹配规则 `name` → 2. 精确匹配 `aliases` 中的 `provider/model` 别名 → 3. 若 provider 被 hidden_providers 隐藏，只按 `model` 部分匹配 → 4. 精确匹配 `model` 别名 → 5. 未命中保持原始名称
- **缓存失效**：`setModelAliasesSetting` / `setHiddenProvidersSetting` 写入时调 `invalidateModelCache()` 清空 `rawToCanonical` + `invalidateQueryCache()`
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
- `/api/cli` 的 `today` 走同一套 `tzOffset` 语义（严格十进制整数，缺省 0 = UTC），日界分组与 `/api/dashboard` 的 `today` 完全一致（同一 `timezoneOffsetMinutes` + `2d` 窗口）；两者数值相等由 `src/app/api/cli/route.test.ts` 的对比用例锁定。
