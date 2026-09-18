# 数据与统计约定

> 上级文档：`AGENTS.md`。改统计口径 / 聚合 / 定价 / 归一化 / 匿名化 / 时区前必读。

## 聚合口径
- 展示层所有 **Total Input** 按 `SUM(input_tokens) + SUM(cache_read)` 计算（含 cache）。
- **Uncached Input** = `SUM(input_tokens)`（不含 cache）。
- **Cached Input** = `SUM(cache_read)`（单独列示）。
- 仅单请求（逐条记录 / `/api/records`）展示区分 `Input (Uncached)` 与 `Input (Cached)`；聚合卡片与图表统一展示 Total Input 含 cache，避免重复扣减。

## Dashboard 视图
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
- **注意**：TTFT = 首个 SSE chunk 到达时间，个别上游先推空 chunk 会略微低估真实首 token 时间，对比用途足够

## Provider 匿名化
- **数据源**：settings 表 `hidden_providers`（admin panel Display tab 编辑，唯一来源，未保存 → 空；无 env fallback，与 model_aliases/hidden_sources 语义一致）
- **唯一 async 入口**：`loadHiddenProviderGroups()`（settings 单一来源）；纯函数一律接收 `groups` 参数显式传参（`anonymizeProvider` / `resolveProviderFilter` / `deanonymizeProvider` / `parseHiddenProviderGroups`），不直接读 env
- **分组语法**：分号分组的通配匹配，如 `CustomA:vendor*`；被隐藏的 provider 在 UI 显示为 "Provider A", "Provider B"... 或自定义名称
- **Provider 维度归并**：同一组内多个真实 provider 在 Provider 维度统计中合并为一行（Top Providers、每日堆叠图、Speed/latency 表），由 `providerGroupKey()` 计算聚合键；组名同时作为 `ProviderStat.provider` 与 `ProviderStat.providerName`，保证前端堆叠图跨日 series 连续；Model 维度仍按归一化 model 名独立聚合，不受影响
- **缓存失效**：`setHiddenProvidersSetting` 写入时调用 `invalidateModelCache()` 清空 `normalizeModel` 的 `rawToCanonical`，面板改分组后立即生效
- **相关文件**：`src/lib/provider-utils.ts`（`providerGroupKey`、`anonymizeProvider`、`resolveProviderFilter`）、`src/lib/model-registry.ts`（`isProviderHidden`）

## Hidden Sources（隐藏 vk / upstream 数据源，`hidden_sources`）

- **语义**：每个名字两个**独立维度**——`upstreams`/`virtualKeys` = 隐藏（从筛选器下拉、分组榜单消失但总计仍计入）；`excludedUpstreams`/`excludedVirtualKeys` = 从聚合统计（总卡片、daily、heatmap、hourly、latency、status 面板）中剔除。四态均可表达（含「剔除但没隐藏」）。数据零删除，仅查询层过滤，取消勾选立即完整恢复
- **匹配口径**：upstream → `token_records.provider`；vk → `token_records.agent`（均为写入时名字快照）；`'unknown'` 遗留记录永远计入总计、不列入可隐藏列表（UI 占位名 `(unknown)`）
- **查询层**：`buildWhereClause` 第 6 参数 `exclude?: {providers, agents}`（`notInArray`，空数组跳过）；`executeStatsQuery`（stats-query.ts）与 `queryLatencyStats`（latency-query.ts，⚠️ 直接调 buildWhereClause 需自行 `loadHiddenSources()`）恒以 excluded 列表传入（与隐藏状态无关）；`/api/records` 明细不受影响
- **distinct 路由**：`/api/agents` **默认返回派生工具名**（`user_agent` 解析，NULL UA 追加 `(unknown)`；hidden vk 过滤不适用）；`?dimension=key` 时按 `agent` 列（vk 名）返回并始终过滤隐藏 vk（不受排除状态影响，`'unknown'` 映射 `(unknown)` 显示，供 DisplaySettings vk 建议列表）；`/api/providers` 在**匿名化之前**按真实名排除（`?includeHidden=1` 跳过过滤且跳过匿名化返回真实名，供管理面板建议列表）；`/api/models` 行级过滤（provider NOT IN ∪ agent NOT IN），隐藏源独有 model 一并消失；三路由均支持 `?includeHidden=1`
- **缓存**：settings 写入经 `withSkipCache` + 主动 `invalidateStatusCache()`（status 响应级缓存 key 只有 tzOffset）
- **删除联动**：upstream/vk DELETE 接受 `?hideHistory=1`（删除确认框复选框，默认不勾），服务端追加名字进 hidden 列表（幂等去重）

## 官方价参考（`model_prices` + models.dev）

- **语义**：价格 = 官方价参考（非真实账单），**查询时计算**（record 不存价格/cost），`src/lib/pricing.ts` 的 `loadPriceMap()` 读全表（cache 价 NULL 回退 input_price，内存缓存）
- **定价键**：一律按真实 model 名（`model_prices.model` = 发往 upstream 的真实名）；归一化 alias 仅作展示层 roll up 分组键；虚拟名（`request_model`）仅追溯，不参与定价
- **成本链路**：`stats-query.ts` 在 model/date-model 分组输出行上按真实名附加 `cost`（`computeModelCost`，未定价 → 全 0）→ 归一化聚合时随行合并（`mergeAggregatedCosts`）；未定价 model 成本为 0，补价后历史立即重算
- **写接口**：`/api/admin/model-prices` PUT/DELETE、select、auto-fill、aliases 均须 `withSkipCache()` + `invalidatePriceCache()`（pricing.ts 内存缓存）；价格变更后 Dashboard/Status 立即反映
- **models.dev 集成**（`src/lib/models-dev/`，纯逻辑可单测）：**双数据源** —— `https://models.dev/api.json`（USD/1M）+ GitHub LiteLLM `model_prices_and_context_window.json`（raw.githubusercontent 主源，jsDelivr CDN 回退；per-token → ×1e6 换算 USD/1M，`sample_spec` 剔除、`litellm_provider` 空/非字符串跳过、无 token 价条目保留为无价条目、batch/reasoning 细分价不取）；两源各自解析器统一输出 `ModelsDevData`，下游零感知；本地快照 `data/models-dev-cache.json`（`{fetchedAt, source, data}`），**单一当前快照语义**（文件 + 内存缓存不拆分，谁最后成功谁是当前快照；旧文件缺 `source` 字段回退 `"models.dev"` 零迁移），**懒刷新 7 天 TTL**（访问时超期则本次用旧快照、后台异步拉新）+ `POST /api/admin/models-dev/refresh` 强制刷新 + `POST /api/admin/models-dev/upload` 手动上传（`uploadSnapshot` 内存缓存 + 落盘立即生效；`sanitizeModelsDevData` 仅上传路径严格校验，非法条目丢弃）；拉取失败静默回退旧快照；**数值信任链兜底**：`isFiniteNonNegative`（有限非负）守卫贯穿 `toCandidate` 与 select 落库，所有快照来源（网络/手工文件/上传）的负数/NaN 价格均回退 0/null，防成本计算污染；**in-flight 竞态对策**：`runRefresh` 同源复用 promise、异源等待 settle 后串行发起（写盘顺序 = 发起顺序，无乱序覆盖）
- **匹配管线**（`match.ts`）：精确 → 归一化（小写去 `-_.`）→ 日期变体剥离（`-\d{8}$`）；多 provider 冲突按内置原厂优先级表自动预选（anthropic > openai > google > deepseek > ...），价格相同不视为冲突，全部候选供 Price Picker Modal 切换。候选集 = 名字命中的条目，**不含同系列不同名**；需要非匹配条目时用 Price Picker 搜索（`searchModelsDevModel`：model id / provider 名归一化子串匹配，上限 50）——搜索选中落库后与自动匹配完全等价（`source='models.dev'` + modelsDevId，hasUpdate/removed 检测照常）
- **自动填充**（`auto-fill.ts`）：双模式契约——**fill 模式**（缺省）只填空行、永不覆盖已有价格；**force 模式**（`overwrite:true` + `isManual` 保护集）覆盖所有非 manual 已定价行（结果 `updated` 计数）；`source='manual'` 的行永不被任何自动流程触碰；触发点：upstream 保存 enabled_models 后（best-effort，只填空）+ auto-fill API 批量填充（`{mode:"fill"|"force"}`）
- **已知限制**（litellm 源）：embedding 模型仅 input 价 → output=0；jsDelivr 缓存滞后 / 超 20MB 拒载（litellm JSON 现约 2-3MB 安全）；litellm 候选搜索噪声（bedrock/azure 变体多，由匹配管线 & Price Picker 消解）
- **徽标判定**（`src/lib/model-prices-service.ts`）：`active`（在任一 enabled_models）/`inactive`（已定价且无任何在用来源且 30 天无流量，价格保留供历史）；`待确认`（未定价且多候选价格不一致）/`未匹配`（未定价无候选）；`有更新`（同源快照同 id 价格不同，带 diff）/`已下架`（同源快照无该 id）——**跨源不比较**：快照源（models.dev/github）与价格行来源不一致时一律不判定有更新/已下架（两源 provider/model 命名体系不同，跨源比较必然误报）；**无价条目不列下架**（快照 id 仍在但 cost 缺失，litellm/models.dev 均保留此类条目）；**排序**：`inactive || removed` 行统一排到行集末尾（组内按 model 名 A→Z，桌面表格与移动卡片同序），红 removed 行不额外隐藏（可见性仍由 active ∪ recentActivity 决定；同时为 inactive 的行仍默认隐藏）；行含 `sourceProvider`（自动来源的 provider 显示名，快照缺失回退 providerId；manual 为 null），表格徽标显示 `{models.dev|LiteLLM} · {providerName}`

## Agent 维度派生（Dashboard Agent = 客户端工具名）

- **语义**：`token_records.agent` 列 = **来源 key 名**（本地 vk 名 / 远程 `remote/{instance}/{vk名}`），继续承担 Hidden Sources vk 维度、同步协议与 ingest 改写（零改动）；Dashboard 的 **Agent 维度显示客户端工具名**（claude-code、opencode 等），由 `user_agent` 列**查询时派生**（不回填、不改历史数据），Records 表 Agent（派生）+ Key（`agent` 列原值）双列展示
- **解析规则**（`src/lib/agent-utils.ts`，纯逻辑可单测）：UA 首段 token（第一个 `/` 前，lowercase）→ 手动 `agent_aliases` 精确匹配（大小写不敏感）→ 内置 `BUILTIN_AGENT_MAP`（claude-cli→claude-code、codex_cli_rs/codex→codex、geminicli→gemini-cli、aider→aider、cursor-agent→cursor 等）→ 未命中回退 token 本身；null/空 UA → `unknown`（筛选 UI 显示 `(unknown)`）
- **注册新 agent 工具**：无需改代码——在 Display pane Agent Aliases 添加 {name, aliases[]} 即可（多 UA token 可映射同一工具名），写入 `setAgentAliasesSetting` 主动 `invalidateQueryCache()` 立即生效
- **过滤器**：Dashboard/Records/CLI 的 `agent` 参数是**派生工具名**，服务端反找（`resolveAgentUserAgents`）映射为 UA 集合后按 `user_agent IN (...)` 过滤；`unknown` 走 `user_agent IS NULL`；未命中 → 400。`buildWhereClause` 的第 4 参数即此 UA 过滤（类型 `AgentUaFilter`），`exclude.agents`（Hidden Sources excludedVirtualKeys）仍按 `agent` 列 NOT IN 排除，两维度并行
- **注意**：反找需 `selectDistinct(user_agent)` 全表扫描（无索引）；个人规模（日均约 1000 行）+ 10s 查询缓存可接受。远程记录（vk=-1）按自身 UA 派生，与本地同名工具合并为一个 agent；instance 区分仍靠 provider 的 `remote/{instance}/` 前缀

## Model 归一化
- **文件**：`src/lib/model-registry.ts`（纯归一化模块，不加载任何文件；`src/lib/model-utils.ts` 仅做薄封装）
- **数据源**：settings 表 `model_aliases`（Display pane 编辑）→ `loadModelAliases()`（与 `loadHiddenProviderGroups()` 同模式，调用方先 await 再注入）；**MODEL_REGISTRY_PATH / model-registry.json 已废弃删除**
- **规则**（按优先级依次匹配）：1. 精确匹配规则 `name` → 2. 精确匹配 `aliases` 中的 `provider/model` 别名 → 3. 若 provider 被 hidden_providers 隐藏，只按 `model` 部分匹配 → 4. 精确匹配 `model` 别名 → 5. 未命中保持原始名称
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
