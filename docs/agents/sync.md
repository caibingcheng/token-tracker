# 多实例同步

> 上级文档：`AGENTS.md`。改 push / ingest / 水位 / uid 前必读。

多级部署：A = 公网主实例（汇总），B = 本地实例（可多个），B 将自己 token_records 推送 A。核心保证：**丢失可能（可观测、有兜底），重复不可能**。

- **身份语义**：**uid**（settings `sync_instance_uid`，`u-[a-f0-9]{32}`，B 首先生成、持久不变、不可编辑、reset 不重置）= 稳定身份键（TOFU/水位/级联删除均按 uid）；**instance name**（settings `sync_instance`）= 纯展示名，随时可改（改名安全、无绑定锁定），重名无害。处理同名同 token 多设备、改名不再重推/历史劈裂
- **两端同代码库**：A/B 均为本仓库，B 仅需在 Admin Sync tab 配置 URL + token；未配置同步时 worker 完全不起动（单机零开销）
- **推送机制**（`src/lib/sync/`）：持久化游标队列 —— settings `sync_cursor` 即队列水位，推送 payload `{instanceUid, instance, epoch, records[]}`（`SELECT id > cursor AND COALESCE(virtual_key_id,0) != -1 ORDER BY id LIMIT 200`），A ack 后推进游标；**严格串行**（拉取 → 推送 → ack → 推进），`SyncPusher` 模块级单例（`src/lib/sync/pusher.ts`）in-flight 互斥锁；onUsage 写库后 fire-and-forget `notify()` + 60s 定时兜底；**单进程假设**（一个 B = 一进程连一 SQLite，不支持同库多进程）
  - **分级重试**：2xx 推进游标（skippedInvalid 计入 `sync_dropped_count`）；401/403 **无限退避不 drop**（1s→5min 封顶，索引 `lastError.type=auth` 红字）；400 连续 50 次自动 drop 该批（推进游标 + dropped 累计 + 审计）；5xx/网络/超时无限重试
  - **错误信息诊断**：网络失败经 `describeFetchError(err)` 沿 `cause` 链（含 AggregateError 多地址展开）提取 code/address/port，映射为人类可读提示（ECONNREFUSED 附 Docker localhost 陷阱提示、ENOTFOUND/EAI_AGAIN → DNS、CERT_* → TLS 证书、TimeoutError → 超时），HTTP 401/403 追加 token/binding 提示、404 追加 URL path 提示；message 截断 300 字符（读取端另有 slice(0, 500) 兜底）；完整 cause 链经 `console.error("[sync] push failed:", err)` 进服务端日志
  - **游标推进细节**：以原始扫描（含被跳过的 -1 记录）的最大 id 推进，防停在哨兵记录前反复空扫；`stream-usage`-式批注
  - **哨兵防级联**：`virtual_key_id = -1` 的记录（经 ingest 进入本机）**不再向外转发** —— 级联拓扑（C→B→A）B 只做末端展示，环路（A→B→A）自然断开；本地 upstream/vk 名新增校验禁止 `remote/` 前缀（保留字隔离命名空间）
- **A 侧接收**（`src/app/ingest/records/route.ts`，/api 之外 + `runtime=nodejs` + `dynamic=force-dynamic`）：`Authorization: Bearer it-xxx` 全表解密比对（仿 `resolveVirtualKey`，**同步 `.all()` 直读 DB** —— withSkipCache 基于 AsyncLocalStorage，async 路径会丢上下文落到缓存读到旧行集）；内存限流 + body ≤2MB + 批 ≤500；TOFU 绑定（先推先绑，**按 uid**，uid 不匹配 403 `instance_mismatch`，响应回显 `boundUid`）；每次推送顺带 `UPDATE sync_instances SET instance_name = ?`（改名即时生效）；**部分接受**（单条非法跳过 + `skippedInvalid` ids，结构性错误整批 400）
- **去重水位**（`src/lib/ingest/watermark.ts`，`BEGIN IMMEDIATE` 单事务）：`sync_instances` 每实例一行 `(uid, instance_name, epoch, last_record_id)`；**epoch 变化 → A 重置水位 0**（B 重建 DB 场景）；`UPDATE ... WHERE last_record_id < :w` 只升不降；同实例并发由 SQLite 单写者串行化（最坏整批 skip）；**同名不同 uid 双设备互不干扰**（水位按 uid 隔离）
- **字段改写**：A 收到后 `provider`/`agent` → `remote/{instance}/{原名}`，`virtual_key_id` → **-1**（哨兵：防转发 + 三态区分本机 vk/NULL/-1），`remote_instance_uid` → **payload.instanceUid**（身份键落库），model/requestModel/sessionId/created_at 等原样保留，created_at 保留 B 原始时间；**契约上拒绝价格字段**（A 是唯一定价权威）
- **定价/统计集成**：推送 model 参与 A 的定价（原名命中 model_prices 自动匹配）+ 归一化（同名 roll up）；`/api/admin/model-prices` 行集 = 启用 upstream ∪ 已定价 ∪ **推送记录出现过的 model**（基于 sync_instances 的 **`uid` 等值匹配 `remote_instance_uid` + OR `instance_name` 前缀 LIKE 兜底**（uid NULL 旧行）有界 distinct + 内存缓存，**改名后历史行仍可发现**），upstreams 列标注 `remote/{instanceName}/{原名}` 来源
- **活跃模型可见性（修正）**：默认可见 = active（启用 upstream）∪ **近 30 天有记录**（含推送）；`inactive` 徽标 = 已定价 && !active && 30 天无流量（与默认可见性口径对齐，默认视图不出现灰 removed 行；`ModelsPanel` 的 `showInactive` 可查看）；remote（推送）来源的徽标/可见性统一由 30 天流量窗口判定（不因不在本机 enabled_models 立即标 removed；30 天无流量后为 inactive 默认隐藏），`recentActivity` 标记由 30 天窗口查询驱动；Speed 表 `loadActiveModelSet()` 同步扩展为「启用 ∪ 近 30 天有记录」
- **Hidden Sources / 匿名化**：B 来源以 `remote/{instance}/{名字}` 出现于建议列表，按名字精确匹配可正常隐藏/剔除，无改动
- **↔ingest 认证隔离**：ingest 端点独立于会话认证体系，token 泄露不影响 admin/API；TOFU 残余风险由 UI 展示绑定关系 + last_used_at 发现并吊销；审计覆盖 token CRUD/解绑/水位删除/skip/reset/config
- **安全重发流程**：A 端 Sync Instances → Delete（勾选 "Also delete its pushed records" 即 `?deleteRecords=1` 级联清历史）→ B 端 Reset sync state（游标归零 + 新 epoch + 解除 uid 锁定，confirm 文案明确重复风险、按钮红系描边）→ B 端正常推送（换不换 token 均可，TOFU 按 uid 重新绑定）→ A 端得到干净全量数据无重复。唯一重复风险组合（A 删实例行但保留记录 + B 端 reset 全量重放）由该流程前端约束消除
- **破坏性变更**（uid 改造，不向后兼容）：协议要求 payload 携带 `instanceUid`（旧 B 推新 A → 400 缺字段）；sync_instances 表重建（旧行丢弃）、ingest_tokens 表重建（行回迁 + bound_uid 置 NULL，需重新 TOFU）；`token_records` 仅补列 `remote_instance_uid`（存量不回填）。**部署顺序先升 A 后升 B**（防旧 B 连续 400 被自动 drop 丢数据）；A 端 unbind token + 删实例水位后 B 升级重推可干净过渡；dev 部署（无同步功能）零影响，迁移幂等自动跳过
