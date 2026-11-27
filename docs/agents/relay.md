# relay / sub node

> 上级文档：`AGENTS.md`。改 relay（sub node）或 `/api/device/*` 前必读。
> 设计规格：`specs/relay-subnode.md`（本地文件，不入库）。

## 一句话

中心仍是唯一决策者（路由、鉴权、配额、健康、定价、写库）；relay 只是客户端的 base_url，把请求体**直接打给上游**，每请求向中心要一次执行计划（plan），结束时回报一次结果（report）。

```
agent ──(vk, base_url = relay)──► relay ──plan/report（≤8KB）──► center
                                     │
                                     └──(真实 upstream key)──► upstream
```

## 两个镜像

| 镜像 | entry | 内容 | 构建 |
|---|---|---|---|
| `token-tracker` | `src/server/index.ts` | bundle + `out/` + better-sqlite3 | `docker build .`（默认 target `runner`） |
| `token-tracker-relay` | `src/relay/main.ts` | **只有** `build/relay.js` | `docker build --target relay .` |

同一仓库、同一次 CI（`.github/workflows/docker.yml` 建两条并推 `-relay` 后缀的同一 tag）。

**relay 的 bundle 里不存在 DB / 认证 / proxy 代码** —— 由 `scripts/build-server.mjs` 的 esbuild plugin 在构建期拦（解析到 `@/lib/db`、`@/lib/auth`、`@/lib/gateway/proxy`、`@/lib/gateway/plan`、`@/lib/device`、`drizzle-orm`、`better-sqlite3` 等直接构建失败），CI 再断言一次产物里没有 `better-sqlite3` / `initDatabase`。

## 本地开发

```bash
npm run dev        # 中心：页面 :3000 + API :3001
npm run dev:relay  # relay：tsx watch src/relay/main.ts，默认 CENTER_URL=http://127.0.0.1:3001 / PORT=3010
```

- 改 `src/relay/**` 或它 import 的 `src/lib/gateway/*` 都会自动重启（tsx watch 跟 import 图）；按回车可强制重启
- 脚本的默认值（仅缺失时填充，已有 env 不覆盖）：`CENTER_URL` / `PORT=3010` / `HOSTNAME=127.0.0.1` / `RELAY_STATE_PATH=./data/relay.state.json` / `RELAY_DEVICE_NAME=dev-relay`；换端口用 `PORT=3011 npm run dev:relay`
- **自动剥离中心专用 env**（`SQLITE_DATABASE_PATH` / `ADMIN_API_KEY` / `GATEWAY_SECRET` / `LOCAL_ADMIN_BYPASS`）：否则同一个 shell 里为 `npm run dev` 导出的变量会让 relay 的启动自检（防误拉错镜像）直接 exit 1。这只是开发脚本的便利，生产镜像仍 fail-closed
- 首次跑：中心 `npm run dev` → relay 终端打印 `[relay] pair code XXXX-XXXX` → `http://localhost:3000/admin/devices` 输码授权 → 5s 内 `[relay] paired as "dev-relay"`，状态写 `data/relay.state.json`（gitignored）
- 本地上下游都在回环：relay→中心是 loopback（sync scope 直接放行）；**relay→本机伪上游（如 :4010）需 `ALLOW_PRIVATE_UPSTREAMS=true`**（本进程 env，不由中心下发）——dev 脚本已默认填入，只想验证 fail-closed 行为时 `ALLOW_PRIVATE_UPSTREAMS=false npm run dev:relay`。漏这一头的典型症状：客户端拿到 `502 {"error":{"message":"Upstream request failed","type":"upstream_error"}}`，relay 终端会打 `[relay] hop 0: private upstream blocked by local policy`，上游日志里**没有**这次请求
- 本脚本不产出 `build/relay.js`；「relay 不得 import DB/auth/proxy」由 `npm run build` 的 esbuild plugin 在构建期拦

### 用 fake upstream 联调（不起真实厂商 key）

```bash
npm run fake-upstream              # 默认 http://127.0.0.1:4010，三协议各 2 个 model + 6 个 key
npm run fake-upstream -- --port 4010 --config my-fake.json
npm run seed:fake-upstream         # 把这些上游写进中心（幂等；--with-broken 追加 401/503 故障项）
```

- 三协议端点：`POST /v1/chat/completions`（openai）、`POST /v1/messages`（anthropic）、`POST /v1beta/models/<model>:generateContent|:streamGenerateContent`（gemini）、`POST /v1/responses`（responses）；`GET /v1/models` / `GET /v1beta/models` 按 key 白名单过滤
- 多 key：各自的协议白名单（`protocols`）、model 白名单（`models`）、固定失败（`fail`）、首次失败（`failFirst`）、延迟（`latencyMs`）——用来手动复现 key 轮换 / failover / 健康标记
- 请求记录：`GET http://127.0.0.1:4010/__fake/requests`（key/model/body/status 全有），`POST /__fake/reset` 清空
- 把它配成一个 upstream（baseUrl = `http://127.0.0.1:4010`，key 用 `sk-fake-openai` 等），**relay→本机伪上游需要 `ALLOW_PRIVATE_UPSTREAMS=true`**（中心侧同样要开，因为 baseUrl 是私网地址）；懒得手填就跑 `npm run seed:fake-upstream`（写 4 条 upstream + key + vk `fake-host-demo`）
- 进程内用法（写测试时）：`const up = await createFakeUpstream({ keys, models })` → `up.url` / `up.requests` / `up.reset()` / `up.close()`，见 `src/dev/fake-upstream/server.ts`

## relay 入口与 env

只有 4 条路由：`/v1/*`、`/v1beta/*`、`/raw/*`（透传）+ `/pair`（内联页）。`/api/*` 一律 404 —— device 端点属于中心，relay 不做 sub node 互通。

| env | 必填 | 说明 |
|---|---|---|
| `CENTER_URL` | ✅ | 中心地址。非环回主机必须 https（除非 `ALLOW_PRIVATE_UPSTREAMS=true`），启动自检 fail-closed |
| `PORT` / `HOSTNAME` | — | 默认 `3000` / `0.0.0.0` |
| `GATEWAY_MAX_BODY_MB` | — | 默认 32，**允许比中心大**（body 不经中心）。启动后首次 plan 会按中心 `policy.centerMaxBodyMb` 打一行 warn/info |
| `RELAY_PAIR_PAGE` | — | `local`（默认：仅环回/私网来源可访问 `/pair`）\| `off`（只用 stdout）\| `on`（全部来源，需自知风险） |
| `RELAY_DEVICE_NAME` | — | 展示名，默认 `relay`（hostname 常含个人信息，故不默认用 hostname）。**只在首次配对时上报给中心**；之后中心改名以中心为准（plan 响应 `device.name` 下发，relay 只存内存） |
| `RELAY_STATE_PATH` | — | 默认 `./data/relay.state.json`（0600） |
| `ALLOW_PRIVATE_UPSTREAMS` | — | 允许私网/环回上游与明文 http 中心（内网自建部署） |

启动自检（§13.1）会拒绝以下情况：出现中心专用 env（`SQLITE_DATABASE_PATH` / `ADMIN_API_KEY` / `LOCAL_ADMIN_BYPASS` / `GATEWAY_SECRET`）、缺 `CENTER_URL`、`CENTER_URL` 非 http(s)、公网明文 http。

## 配对（RFC 8628）

1. relay 首次启动生成 X25519 密钥对 + `fingerprint`（`u-` + 32 hex）写 `data/relay.state.json`（0600）。
2. `POST /api/device/pair/start` → 中心生成 **8 位码**（`ABCD-EFGH`，字符集排除 `0 O I 1`，TTL 600s，只存 sha256），relay 打印 `[relay] pair code …`（也可看 `/pair` 页）。
3. 管理员在中心 **Admin → Devices** 输码 → 看到 name / fingerprint / IP → Authorize（或 Deny）。
   - 页面每 3s 自动拉一次待授权列表，**relay 一发起配对就出现**，可直接点 Authorize（内部用 `pairingId`=code_hash，无需输码）；输码框保留给「relay 在另一个网络、只能看日志」的场景。
   - 授权后该设备以 `pending` 出现，relay 下一次 poll 拿到 token 后自动变 `active`（同样靠轮询，不用刷新页）。
   - **改名以中心为准**：`PATCH /api/admin/devices/:id` 改完不用重启 relay —— 下一次 plan 响应的 `device.name` 就会带回新名（relay 只存内存并更新 `/pair` 页），没有任何心跳/长轮询。
4. relay 按 `interval`（5s，`slow_down` 会翻倍至 30s）轮询 `POST /api/device/pair/poll`，取到 `dt-` token 后落盘，配对页上的码立即消失。
5. `fingerprint` 命中已有 device 行 → **reauth**：复用同一 `device_id`（历史记录不断链），只换 token。
6. **`/pair` 页自己会刷新**：页面查 `GET /pair/status`（同一份 `pairView()`，不含 token/私钥），**只在派生值变化时** `location.reload()` —— 待授权→已配对、中心改名、Last plan 变化都会自动出现，静止时不闪。频率：配对中 2s，已配对/已失败 15s。浏览器侧轮询，relay 进程里没有新 timer。

`/pair` 页展示白名单：码（仅 pending）、设备名（HTML 转义）、fingerprint 前 8 位、`scheme://host`、最近一次 plan 结果（状态码）。**永不**展示 device token / 私钥 / vk / upstream key。

## 数据面

| 端点 | 认证 | 说明 |
|---|---|---|
| `POST /api/device/plan` | device token | 一次请求一次计划（不跨请求缓存：配额必须请求前判，body 只在 relay 手上） |
| `POST /api/device/report` | device token | 结束回报；幂等（重复回报只生效一次），`planId` 不存在或 device 不匹配 → 404 |

- **决策全在 `src/lib/gateway/plan.ts` 的 `buildPlan()`**，与 `proxy.ts` 的链组装**刻意不共用代码**，一致性由 `plan.contract.test.ts` 用 `proxy.ts` 当 oracle 保证（同一份 fixture 跑两条路径，比较真实尝试序列）。
- **hop = (upstream, key)**，每个 hop 带一个 `keyLease`（`src/lib/gateway/lease.ts`）：X25519 ECDH + HKDF(planId) + AES-256-GCM，AAD 绑定 `planId|upstreamId|keyId`，TTL 60s（relay 允许 ±120s 漂移）。中心只存 device 公钥，不存在能解开全部 lease 的对称密钥。
- **hop 字段语义**（relay 不写策略 if，只读字段）：`continueOn` 决定「还能不能继续试」（429/5xx/网络 → 同 key 重试；401 → 换 key；403/404 → 见 `skipSiblingsOn`；其他 4xx → 直接透传并终止全链）、`skipSiblingsOn = ["403","404"]`（跳过该 upstream 剩余 key，与直连的 upstream 级判定一致）、`passthrough`（`last-4xx` / `last-business`）决定全链耗尽时透传哪份保留响应，并附一条零 token 的 `no_usage` 记录。
- **per-device upstream key 已可用**：`upstream_keys.device_id` 由上游 key 表单写入（下拉「Bind new keys to a relay device」），列表标 `device: <name>`；直连路径、探活、分类器与 `fetch-models` 一律只用通用 key（`device_id IS NULL`），只有该 device 的 plan 才会拿到专属 key（专属优先）。
- **写库素材以中心为准**：`device_plans` 行在 plan 时定下 `realModel` / `session_id` / `record_session_id` / `request_model` / `user_agent`，report 只回 `hopIndex`。
- **健康标记分 mode**（`src/lib/device/report.ts`）：router 的 403(json)/404 → model 级；403 html（边缘拦截）与 429/5xx 不标记；`responses-create` 的 403/404 不标记；`responses-subresource` 的 403/404 零标记；401/网络 → 同 upstream 全 key 覆盖才 `markUnhealthy`；`winner` → `markHealthy` + `markModelHealthy`。
- **配额**：`checkQuota` 用量 = DB 聚合 + 中心在途 + **relay 预留**（`device_plans` 未上报且未过期的 `reserved_token/rpm`，见 `quota-db.ts`）。预留 TTL 10 分钟，每 60s 惰性清扫（`maybeSweep`，plan/report 请求时触发，不额外建 timer）；未上报就过期的行计入 `relay_gap_count`（`GET /api/admin/devices/stats` 可见）。
- **responses 子资源**（`/v1/responses/{id}…`）与 `GET */models` 由 plan 分别给出「全 openai upstream 无状态遍历链」与「模型快照」，relay 本地返回，不需要 307 回中心。

## 版本协商

plan 请求带 `relayVersion`，中心维护 `MIN_RELAY_VERSION`（`src/routes/api/device/plan/route.ts`）；过低 → **426 `relay_too_old`**（客户端可见，提示升级 relay）。反向（中心旧、relay 新）由 relay 在 plan 收到 404 / 未知字段时提示「中心未升级」。

## 故障排查

| 现象 | 原因 | 修法 |
|---|---|---|
| `503 relay_not_paired` | 还没配对 / 状态文件丢了 / device token 刚被中心拒绝并清掉 | 看 `docker logs` 或 `/pair` 取码，去中心 Admin → Devices 授权 |
| plan 401（中心回 `{success:false,error:"Invalid or revoked device token"}`） | device 被删除、或 admin 在中心点了 Rotate token（旧 token 立即失效） | **自愈**：relay 识别出这类 401 → 清本地 token、写 state、自动重新配对（`recoverFromRejectedToken`），客户端收到 `503 relay_unpaired`，`/pair` 页直接出现新码；同 fingerprint 重新授权即 reauth，记录不断链 |
| plan 401 `invalid_api_key` | vk 指纹未命中（vk 被删/换 key，或 `key_fingerprint` 未回填） | 检查 vk；`GATEWAY_SECRET` 必须存在（回填与 lease 都需要） |
| plan 403 `model_not_allowed` | vk 的 `enabled_models` 不含该 model | 改 vk allowlist |
| plan 404 `model_not_found` / 400 `protocol_mismatch` | model 不在该协议的 upstream 上 | 检查 enabled_models / 协议 |
| plan 502 `upstream_unavailable` / `named_route_unavailable` | 全候选 givenUp / 命名路由目标池解析不出 hop | 看上游健康与命名路由目标 |
| plan 429 `rate_limited` | 每 device plan/report >20 rps | 降低并发（进程内限流，不占 vk 配额） |
| 413 | 本地 `GATEWAY_MAX_BODY_MB` 小于请求体 | 调大本端值（body 不经中心，中心上限不再约束） |
| `502 upstream_error` | 全链失败且无可透传的 4xx | 看 relay 日志（不回显内网地址/上游名） |
| `relay_gap_count` 增长 | relay 崩溃/断网导致 report 丢失 | 丢失即丢失（无本地库）；该 vk 配额最多紧 10 分钟 |

## 安全边界（必须知道）

- **relay 被攻破 = 已下发的 upstream key 泄露**（60s TTL 内的 lease）。per-device upstream key（`upstream_keys.device_id`，上游 key 表单可写入、可单独吊销）能把「永久泄露」降为「可单独吊销」。
- report 无签名（同一 device token 认证），`failures` 会驱动全局健康标记 —— 伪造可把共享 upstream 打挂。已有 per-device 限流（20 rps），健康写入在中心侧记 `device_id` 可审计。
- 中心下发的 URL 每次请求前都过 `assertOutboundUrlAllowed(url, "upstream")`；私网 upstream 还需 relay 本地 `ALLOW_PRIVATE_UPSTREAMS`（双条件，fail-closed，原因不回显客户端）。
- 出站一律 `redirect: "manual"` + 受保护 dispatcher；不跟随 3xx（防 key 跨源泄露）。

## 已知限制

- **LLM 分类器在 relay 上退化**：分类器需要请求 body 生成摘要，而 relay 只送 `sessionInput`（≤2KB）。当前 `kind='model'` 的命名路由在 relay 流量上按 priority 选链首。要真正对齐需在 plan 请求里加分类器摘要字段（**待定**）。
- **devices 列表不显示 token 前缀**：中心只存 `sha256(token)`，哈希不可反推且表里无前缀列，所以按 `name` + `fingerprint` 前 8 位 + `last_seen_at` 识别（**确定不做前缀列**）。

## 相关代码

| 文件 | 职责 |
|---|---|
| `src/lib/gateway/plan.ts` | `buildPlan()`：唯一决策点（中心） |
| `src/lib/gateway/lease.ts` | lease seal/open + `generateDeviceKeypair` |
| `src/lib/gateway/plan.contract.test.ts` | 与 `proxy.ts` 的链组装契约（oracle 测试） |
| `src/lib/device/*` | 配对 / token / device store / report 健康规则 / plan deps / vk 指纹解析 |
| `src/lib/auth/device-guard.ts` | `withDeviceAuth`（device token，与 `withAuth` 平行不复用） |
| `src/routes/api/device/**` | pair/start、pair/poll、pair/lookup（会话态）、plan、report |
| `src/routes/api/admin/devices/**` | 列表 / 配对授权 / 改名 / 撤销 / 轮换 token / 删除 / 统计 |
| `src/relay/**` | relay 执行器与内联配对页（不得 import DB / 认证 / proxy） |
| `src/components/admin/DevicesPanel.tsx` | `/admin/devices` 页面 |
| `src/dev/fake-upstream/**` | 三协议模拟上游（openai / anthropic / gemini / responses）：多 key 多 model + 失败注入 + 请求日志；`npm run fake-upstream` 起进程，或 `createFakeUpstream()` 进程内用 |
