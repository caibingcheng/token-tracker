# 内存优化实测记录

> 本文件记录 2026-11 这一轮内存优化的测量方法、原始数据和结论。
> 所有数字都可以用 `bench/` 下的脚本复现；原始采样在 `bench/out/<label>/`（不入库）。
>
> **bench 不写死任何凭据**：首次运行 shell 脚本时自动生成 `GATEWAY_SECRET` / `ADMIN_API_KEY` /
> 虚拟 key 到 `bench/.state/`（权限 600，已 gitignore），之后复用，保证 seed 写库、容器解密、
> loadgen 发请求三方一致。删掉 `.state/` 会让旧库里的 virtual_keys 解不开，重新 seed 即可。
>
> **bench 只碰自己的临时库**：所有数据库操作都经 `bench/lib/guard.mjs` 的 `guardBenchPath()`
> 校验路径必须落在 `bench/` 内，仓库正在用的 `data/token-tracker.db` 会被直接拒绝
> （`init-db.ts` 会执行建表/迁移，指错路径是真实风险）。

## 1. 测量口径（先读这一节，否则数字会读错）

同一个进程在三个地方能读出三个完全不同的「内存」：

| 口径 | 来源 | 包含什么 | 用途 |
|---|---|---|---|
| `VmRSS` | `/proc/<pid>/status` | V8 堆 + malloc + **node 二进制/系统库代码页** | 本地裸跑对比，**不能和 docker stats 比** |
| `memory.current` | cgroup v2 | 容器全部页，含 page cache | cgroup 总量，**跨轮次不可比**（见下） |
| `docker stats` MEM USAGE | `memory.current - inactive_file` | 扣掉冷 page cache | **用户实际看到的数字**，本文件的结论口径 |
| `anon` | `memory.stat` | 匿名页 = V8 堆 + malloc | **最干净的跨轮次可比指标** |

实测对照（同一镜像、同一份 db、idle）：

```
裸跑 VmRSS 112.8MB = RssFile 63.2MB(代码页) + RssAnon 49.6MB
容器 current  52.3MB = file   0.5MB          + anon  51.8MB
```

node 二进制在 overlay 下层，它的页不计入容器 `file`，所以裸跑多算 63MB。**上一轮报告用 VmRSS 得出的「134–149MB」不能和 100MB 的观测直接比较。**

### cgroup `file` 记账的坑

一个文件页只记在**首次 fault 它**的 cgroup。同一份 db，先跑的容器可能把整份 page cache 吃进 `file`，后跑的容器是 0：

```
db3-before-gwonly   current=154.2  docker stats=78.5  file=85.0
db3-after-gwonly    current= 71.2  docker stats=67.1  file= 8.1
```

`current` 差 83MB，`docker stats` 只差 11.4MB。**所以本文件一律用 `docker stats` 值（`statsUsage`）和 `anon`，不用 `current`。** 这也是我上一轮把「纯网关 −54%」写错的原因。

## 2. 环境

- WSL2 Ubuntu 24.04 / Docker 29.8 / cgroup v2 / 8GB 内存
- 镜像 `node:22-slim`，`output: standalone`，`LD_PRELOAD=libjemalloc.so`
- 测试库：SQLite 30 天 × 10000 条 = 30 万行（136MB），8 模型 / 3 provider / 4 客户端
- 上游：本地 mock（OpenAI / Anthropic / Gemini 三协议，含 SSE）
- 对照组：`tt:before` = `git archive HEAD`，`tt:after` = 优化后工作区

## 3. 场景

| 场景 | 参数 | 说明 |
|---|---|---|
| 混合 240s | 8 并发网关 + 4 rps 管理 API，240s 压测 + 180–300s 回落 | 压力上限，用来暴露峰值和缓存膨胀 |
| 混合 600s | 2 并发 + 500ms think + 0.5 rps 管理 API，600s | 接近真实使用 |
| 纯网关 240s | 2 并发 + 500ms think，只打 `/v1/*`，240s | agent 客户端日常调用，不看面板 |

## 4. 结果

### 4.1 混合场景（含 Dashboard/Records/Models 面板查询）

> 口径：before n=4、after n=5（标准配置），排除 `API_CACHE_TTL_MS=0` 的特例轮（它只用于 5.2 的排除项验证）。
> 中位数：偶数个样本取中间两者均值。括号内为逐轮实测值。

| 指标 | before | after | 变化 |
|---|---|---|---|
| docker stats 回落稳态 | **96.0 MB**（95.6 / 96.0 / 95.9 / 97.3） | **90.3 MB**（88.7 / 88.7 / 90.3 / 91.7 / 93.7） | **−5.9%** |
| anon 回落稳态 | 83.3 MB（80.6–83.5） | 78.8 MB（78.1–79.2） | −5.4% |
| 压测稳态（docker stats） | 289.8 MB（264.6–291.1） | 117.4 MB（113.9–126.4） | **−59.5%** |
| 峰值（docker stats） | 318.7 MB（308.4–333.2） | 150.6 MB（143.7–157.5） | **−52.7%** |
| anon 峰值 | 298.4 MB | 133.7 MB | −55.2% |
| idle | 52.2 MB（51.7–54.1） | 51.2 MB（50.0–56.5） | 持平 |
| 吞吐（8 并发压满） | 36.5 rps（32.0–41.9） | 33.4 rps（26.6–36.2） | 约 −8%，噪声 ±25% |
| p95（混合） | 1593 ms | 1608 ms | +1% |
| CPU（单样本） | 83.4% | 88.6% | +5.2pp |
| idle CPU | 0.2% | 0.3% | +0.1pp |

### 4.2 纯网关场景（不看面板）

| 指标 | before | after | 变化 |
|---|---|---|---|
| docker stats 回落稳态 | **78.5 MB** | **67.1 MB** | **−14.5%** |
| anon 回落稳态 | 63.0 MB | 59.1 MB | −6.2% |
| 峰值（docker stats） | 115.9 MB | 87.7 MB | −24.3% |
| 吞吐 | 43.4 rps | 40.8 rps | −6.0% |
| p95 | 59.5 ms | 61.0 ms | +2.5% |
| CPU | — | 33.4% | — |

## 5. 结论

### 5.1 目标达成判定

| 目标 | 判定 |
|---|---|
| 峰值不再冲到 300MB | ✅ 317.9 → 147.2 |
| 压测期间稳态 | ✅ 288.2 → 116.7 |
| **纯网关常驻 < 80MB** | ✅ **67.1 MB** |
| **含面板常驻 < 80MB** | ❌ **90.3 MB**，差 10MB |

**用户观测的「100MB 量级」对应混合场景 95.9MB，优化后 90.3MB —— 只解决了 5.8%。** 峰值改善了 54%，但那不是日常读数。

### 5.2 剩余 10MB 的归因（已排除缓存）

| 假设 | 验证 | 结论 |
|---|---|---|
| 查询缓存占 8MB | `API_CACHE_TTL_MS=0` 跑一轮 → anon 稳态 78.8（与有缓存 78.8 完全相同） | ❌ 排除。LRU 8MB 上限实际没被填满（TTL 10s + 每次写入 clear） |
| models.dev 快照常驻 33MB | 20s 闲置阈值 + 240s 回落后 anon 78.8（与不释放的 79.0 相同） | ❌ 对混合稳态无效。快照确实被释放了（单独实验 98→65），但 dashboard 查询把 V8 堆撑上去后不缩回来 |
| V8 堆 + 懒加载模块 | 纯网关 59.1 → 混合 78.8，差 19.7MB 无法通过配置削掉 | ✅ 这是真实瓶颈 |

**结论：混合场景的下限由 Next.js 应用在处理 dashboard 全表扫描时的堆扩容决定，不是缓存也不是快照。** 要再降只能换运行时或砍 SSR。

### 5.3 各项改动的真实贡献

| 改动 | 贡献 | 证据 |
|---|---|---|
| `latency-query.ts` 游标 + 增量聚合 | 混合场景峰值 317.9 → ~260（WSL 同环境单测：415 → 260）；纯网关场景**无关**（不执行该查询） | `bench/out/E-latency` vs `A-256` |
| `instrumentation.ts` GC 30s | 纯网关稳态 154.2(current) → 71.2(current)；这是纯网关改善的主因 | `db3-before-gwonly` vs `db3-after-gwonly` |
| `Dockerfile` heap 128MB + semi 4MB | heapTotal 峰值 206 → 71（WSL 同环境） | `bench/out/A-256` vs `P-final` |
| `--optimize-for-size` | 峰值 220 → 182（WSL，未分离到 Docker）；代价是吞吐 | `N-jemalloc-tune` vs `O-opt4size` |
| `cache.ts` 字节上限 | 稳态无可测收益，但修掉了「1000 条 × 数百 KB」这个真实缺陷 | `db7-after-nocache` |
| `snapshot.ts` 空闲释放 | 面板不用时回收 33MB（98→65）；有网关常驻流量时无效 | `bench/docker-snapshot-test.sh` |

## 6. 方法学局限

1. **吞吐噪声 ±25%**：after 六轮 26.6–36.2 rps，before 四轮 32.0–41.9。「−8%」是中位数差，不是可信的精确值。要下结论需每场景 ≥5 轮取中位数。
2. **CPU 只有单样本**（db3 一组）。
3. **before 的 GC 周期是 5 分钟**，而回落观察只给 180–300s，所以部分 before 稳态是「GC 前的高位」（177.2），部分是「恰好 GC 后」（96.0）。用一个单点代表 before 基线不成立，本文件用中位数 + 区间。
4. **`file` 记账顺序偏差**（见 1.1），所以不用 `current`。
5. 测试机是 WSL2，不是裸 Linux；jemalloc 从 .deb 解包后 `LD_PRELOAD`，与生产镜像内一致。

## 7. 回归验证

### 7.1 单元测试

```
$ npx vitest run
 Test Files  94 passed (94)
      Tests  1426 passed (1426)
```

新增 4 个 `snapshot.test.ts` 用例：热身期不释放、超时后释放并从磁盘重载、无缓存时 no-op、in-flight 刷新期间不释放。

### 7.2 类型与 lint

```
$ npx tsc --noEmit     # 无输出
$ npx eslint src/lib/latency-query.ts src/lib/db/cache.ts src/lib/db/index.ts src/instrumentation.ts  # 无输出
```

### 7.3 聚合结果等价性

`bench/verify-latency.ts`：同一 30 万行库，游标路径与「全量数组 + 聚合函数」路径

```
rows=307816 byModel=16 daily=31 dailyByModel=31
OK: cursor path matches array path exactly
```

覆盖了 `raw(true)` 列顺序、`toSQL()` 参数绑定、分位数/排序的逐字节一致。

### 7.4 端到端（三协议透传 + 落库 + 错误路径）

`bench/e2e.sh`：**33/33 通过**

- OpenAI `POST /v1/chat/completions` 非流式 + 流式（SSE `[DONE]`），响应带 usage，记录数逐条核对
- Anthropic `POST /v1/messages` 非流式 + 流式（`message_stop`）
- Gemini `POST /v1beta/models/<m>:generateContent`
- 无虚拟 key → 401；未知模型 → 404 `model_not_found`
- 上游宕机 → 502 且响应体不含 upstream 名/内网地址
- `/v1/models` 三协议并集
- 8 个管理 API 全部 200
- Dashboard latency 聚合 `byModel=16 daily=3`，数值均为有限数

### 7.5 Docker 镜像内压测

`tt:before` / `tt:after` 各自 240s 混合压测，所有轮次 `fail=0`（每轮 4000–19000 条记录全部成功写入，无 401/502/超时）。

## 8. 复现

```bash
# 两个镜像
git archive HEAD | tar -x -C /tmp/src-before && docker build -t tt:before /tmp/src-before
docker build -t tt:after .

# 三个场景
IMAGE=tt:before LABEL=before      bash bench/docker-bench.sh
IMAGE=tt:after  LABEL=after       bash bench/docker-bench.sh
IMAGE=tt:after  LABEL=gw          SCENARIO=gateway CONCURRENCY=2 THINK_MS=500 bash bench/docker-bench.sh

# 排除项验证
IMAGE=tt:after LABEL=nocache   EXTRA_ENV="-e API_CACHE_TTL_MS=0" bash bench/docker-bench.sh
bash bench/docker-snapshot-test.sh 20000     # 快照空闲释放

# 汇总（docker stats 口径 + anon）
node bench/recalc-stats-usage.mjs before after gw nocache

# 回归（e2e 会用自己的 bench/e2e-data/e2e.db 重建，不受现有数据影响）
npx vitest run
npx tsx bench/init-db.ts bench/data/bench.db
npx tsx bench/verify-latency.ts bench/data/bench.db
bash bench/e2e.sh
```

5.3 节引用的 WSL 裸跑对照（`A-256` / `E-latency` / `P-final` / `N-jemalloc-tune` / `O-opt4size`）用 `bench/run.sh` 生成，
它跑 `.next/standalone/server.js` 并用 `bench/probe.cjs` 注入 `process.memoryUsage()`，
口径是进程 RSS（含代码页），**只用于单变量 A/B，不和 docker stats 混比**：

```bash
LABEL=A-256   NODE_FLAGS="--max-old-space-size=256 --expose-gc --max-semi-space-size=8" bash bench/run.sh
LABEL=P-final NODE_FLAGS="--max-old-space-size=128 --expose-gc --max-semi-space-size=4" \
  NODE_ARGS="--optimize-for-size" JEMALLOC=/path/to/libjemalloc.so.2 bash bench/run.sh
```

## 9. 如需继续推进

按收益排序，都还没做：

1. **面板场景的堆扩容**：给 dashboard 的 10 个聚合查询加「查询期间降低 heap 上限」不可行；可行的是把 `queryLatencyStats` 之外的其他全表扫描也下推到 SQL（目前只有 latency 这一条是全表拉行）
2. **换运行时**：网关拆 Go/Rust（~20MB）+ 前端静态导出，才可能真正稳定 <80MB，代价是重写 7000 行网关逻辑
3. **接受现状**：纯网关 67MB 已达标，面板场景 90MB 对 512MB VPS 不构成压力

## 10. 换运行时 spike（Phase 2，2026-11-22）

> 目标：验证「瓶颈是不是 Next.js 运行时」。做法是用 496 行适配层把 `next/server` 换成 shim（业务代码零改动），
> 服务端换 Hono、前端 `output: 'export'`。**spike 代码不在 `dev` 上**，在分支 `bench/runtime-spike`
> （`git checkout bench/runtime-spike`；该分支自带 `src/server-spike/README.md`）。本文件只保留可复用的数字与方法，
> 完整交接见 `docs/handoffs/20261122181000-handoff-runtime-spike-result.md`。
> 数字取 rebase 到 `origin/dev@0e9ab0f`（Next 16.4.6 + gateway usage 估算 + dashboard 多选筛选）之后的第二轮，
> 6 轮采样全部在 `bench/out/r2-*`。第一轮在旧基线上结论一致（见 10.5 第 2 条）。

### 10.1 两个镜像

| 镜像 | 内容 | 构建 |
|---|---|---|
| `tt:next2` | `git archive HEAD`（含 Phase 1 全部改动）= 本节的基线 | `docker build -t tt:next2 /tmp/src-next2` |
| `tt:spike2` | 同一份 `src/lib`/`src/components`，服务端换 Hono（esbuild bundle）+ 前端 `output: 'export'` | `docker build -f Dockerfile.spike -t tt:spike2 .`（`Dockerfile.spike` 在 `bench/runtime-spike` 分支） |

runner 阶段逐字对齐：同 `node:22-slim`、同 `NODE_OPTIONS`（128/4/semi）、同 `--optimize-for-size`、
同 `LD_PRELOAD=libjemalloc.so`。**唯一变量是「不再跑 .next/standalone/server.js」。**

### 10.2 三场景对比（docker stats 口径，压测结束后的回落稳态）

| 场景 | 指标 | tt:next2 | tt:spike2 | 变化 |
|---|---|---|---|---|
| 混合压测<br>(8 并发 + 4rps 面板, 240s) | 回落稳态 | **102.1** | **72.7** | **−29.4 MB / −29%** |
| | anon 回落 | 83.1 | 62.1 | −21.0 MB |
| | 峰值 | 159.9 | 131.2 | −18% |
| | idle（压测前） | 55.1 | 25.6 | −54% |
| | 吞吐 / p95 | 34.6 rps / 1698 ms | 38.0 rps / 1654 ms | 噪声内（±25%） |
| 混合低 QPS<br>(2 并发 + 500ms think + 0.5rps, 600s) | 回落稳态 | **83.6** | **64.7** | **−18.9 MB / −23%** |
| | anon 回落 | 74.9 | 56.9 | −18.0 MB |
| | 峰值 | 138.6 | 129.1 | −7% |
| | idle | 46.9 | 26.1 | −44% |
| | 吞吐 / p95 | 3.1 rps / 1575 ms | 3.1 rps / 1583 ms | 持平 |
| 纯网关<br>(2 并发 + 500ms think, 240s) | 回落稳态 | **57.8** | **50.0** | **−7.8 MB / −13%** |
| | anon 回落 | 54.2 | 43.4 | −10.8 MB |
| | 峰值 | 82.0 | 59.0 | −28% |
| | idle | 48.6 | 29.0 | −40% |
| | 吞吐 / p95 | 3.6 rps / 63.9 ms | 3.6 rps / 59.8 ms | 持平 |

**`<80MB` 目标（混合场景口径）换运行时后三场景全部达成**（72.7 / 64.7 / 50.0）。
纯网关比 Phase 1 的 67.1MB 再低一档，但那是另一轮的基线，不交叉比较。

复现：

```bash
# spike 代码在分支 bench/runtime-spike（详见该分支的 src/server-spike/README.md）
# Linux 侧副本（node_modules 必须是 linux 原生的，不能在 /mnt/c 下跑 npx tsx）
git archive HEAD | tar -x -C ~/tt2 && cd ~/tt2 && npm ci
cp <repo>/bench/run-spike-comparison.sh bench/ && bash bench/run-spike-comparison.sh
# 换基线/重跑：PREFIX=r2- NEXT_IMAGE=tt:next2 SPIKE_IMAGE=tt:spike2 bash bench/run-spike-comparison.sh
```

### 10.3 归因：Next 运行时到底是哪一块

| | idle anon | 混合稳态 anon | 负载增量 | 换运行时省下 |
|---|---|---|---|---|
| tt:next2 | 44.2 | 83.1 | +38.9 | — |
| tt:spike2 | 23.8 | 62.1 | +38.3 | **−21.0（常数项）** |

1. **Next 运行时 = 约 21MB 的常数项**：idle 从 55/44 掉到 26/24，混合稳态同步掉 21MB。
   这部分是框架的模块图 + proxy 运行时 + 路由表，与跑什么查询无关。两轮测量里这个常数都是 21.0MB
   （旧基线 20.9MB），非常稳定。
2. **混合 vs 纯网关的 ~20MB 差值换运行时后一点没变**：Phase 1 测到 `78.8 − 59.1 = 19.7MB`（§5.2），
   换运行时后 `62.1 − 43.4 = 18.7MB`。**这 20MB 与 Next 无关**，是 dashboard/records 聚合查询把
   V8 堆撑上去后不缩回的工作集 —— 只有把聚合下推到 SQL（§9 第 1 条）才动得了。
3. 峰值降 7–28%（混合压测 160→131、纯网关 82→59），降幅小于稳态，说明峰值里仍有较大一块
   是 better-sqlite3 native 分配 + 请求体缓冲，与运行时无关。

### 10.4 功能等价（不是只测内存）

- `bench/e2e.sh` 打 spike：**33/33 通过**。含三协议流式 SSE（`[DONE]` / `message_stop`）、
  逐条落库核对、无 key 401、未知模型 404、上游宕机 502 且不泄漏、`/v1/models` 并集、
  8 个管理 API、Dashboard latency 聚合 `byModel=12 daily=3`。
  用法：`E2E_SERVER_CMD="node build/server-spike.js" bash bench/e2e.sh`（该变量已入库，可对任意服务端跑）
- **覆盖范围有限**：spike 只挂了 45 条静态路径路由 + 3 个 catch-all，`/api/admin/**/[id]` 这 17 条动态段
  路由没挂（e2e 打的 8 个管理 API 全是静态路径）。所以 33/33 证明的是「网关链路 + 只读面板」等价，
  不是全体 66 条等价。
- 静态导出 + Hono 托管：`/`、`/admin`、`/records` 均 200，未知路径 404；
  `next.config.js` 里 `headers()` 的 5 个安全头（CSP/XFO/nosniff/Referrer/Permissions）
  逐字搬到 `src/server-spike/index.ts`，实测响应头与 Next 版一致。
- 6 轮压测没有 5xx；`net: TypeError` 偶发（压测 1 次、低 QPS 7/4 次）为 loadgen 客户端侧错误，两侧同现。

### 10.5 方法学注意

1. **cgroup file 记账会让 docker stats 假性偏高**：某轮 `file` 峰值 177.2MB（136MB 的 db 页全记进了
   这个 cgroup），`statsUsage = current − inactive_file` 只扣冷页，`active_file` 留在账上，
   同一进程能读出 208MB。**跨轮次比较一律看 anon**（§1.1 的规矩在这里再次成立）。
   本节 10.2 的「峰值」取 `load.statsUsage.max`，不用 `peakCurrent`（后者含 page cache）。
2. **两轮独立测量**：第一轮在 rebase 前的基线（Next 16.4.3），混合压测 91.4→68.8、低 QPS 88.6→65.1、
   纯网关 58.2→48.9；第二轮（本节，Next 16.4.6 + usage 估算 + 面板多选）整体水位抬了 4–10MB，
   绝对值不同但**差值与结论完全一致**（anon 常数 20.9 与 21.0）。第一轮的原始采样随 WSL 重启丢失，
   只保留聚合值；第二轮的 `bench/out/r2-*` 齐全。
3. 单轮吞吐不作结论（§6 第 1 条）；本节的稳态内存单轮即可。
4. spike 的 dispatcher 只挂了 45 条静态路径路由 + 3 个 catch-all 代理入口，
   **20 条动态段路由（`[id]` 等）没有挂载**（bench 与 e2e 都不打它们），
   `params` 恒为空对象。真正迁移时必须补参数抽取。

## 11. 正式迁移落地实测（Hono 替换 Next 服务端，2026-11-23）

> §10 的 spike 已转正：65 个 route 移到 `src/routes/`、`next/server` 由 shim 别名兜住、
> 路由注册 codegen（`scripts/gen-routes.mjs`）、前端 `output:'export'`、生产单 bundle
> `build/server.js` + `out/` + 单架构 better-sqlite3 三件套进镜像。
> 回归：vitest 1469/1469、tsc 0、eslint 0、`bench/e2e.sh` **35/35**（新增 2 条动态段
> `[id]` 正向断言，补掉 §10.5 第 4 条的盲区）、`npm run build` 0、容器冒烟全过、
> dev 双进程（next dev :3000 + Hono :3001 同源 rewrite）链路验证通过。

### 11.1 环境差异（先读，否则数字读错）

- **换机**：本轮 docker-stats 显示 31.02GiB —— §10 的测试机是 8GB WSL2。
  **吞吐/p95 不与 §10 跨轮比较**，只记录不作结论；内存口径（flags + heap 上限主导）
  可比性较高，但仍受 §6 单轮噪声约束。
- `docker-bench.sh` 修了一个潜伏 bug：`--network host` 下没把 `PORT` 传进容器
  （镜像默认 3000），`PORT=` 覆盖从未生效过，宿主机 :3000 空闲时才碰巧能跑。
  本机 :3000 被 nghttpx 占用，补 `-e PORT="$PORT"` 后以 `PORT=30110` 运行。

### 11.2 混合场景（SCENARIO=all：8 并发网关 + 4 rps 管理 API，300s 压测）

镜像 `tt:hono`， LABEL `hono`，原始采样 `bench/out/hono/`，单轮：

| 指标 | tt:next2（§10.2） | tt:spike2（§10.2） | **tt:hono（本轮）** |
|---|---|---|---|
| idle（压测前，docker stats） | 55.1 | 25.6 | **32.0** |
| 压测回落稳态（docker stats） | 102.1 | 72.7 | **45.6** |
| anon 回落稳态 | 83.1 | 62.1 | **43.1** |
| 压测稳态（docker stats） | —（§10 未列） | — | **69.6** |
| 峰值（docker stats） | 159.9 | 131.2 | **98.1** |
| anon 峰值 | — | — | **94.9** |
| 吞吐 / p95 / 失败 | 34.6 rps / 1698ms | 38.0 rps / 1654ms | **98.8 rps / 231.8ms / 0 fail**（换机，仅记录） |

吞吐注脚：29661 请求全部成功（fail=0，p50 44.7ms / p99 1188.7ms）。§10.2 的 rps 是
8GB WSL2 上的数字，两者不可比。

### 11.3 判定

| §5.1 遗留目标 | 本轮 |
|---|---|
| **含面板常驻 < 80MB**（上一轮 ❌ 90.3） | ✅ **45.6**（anon 43.1），余量 45%+ |
| 峰值不再冲 300MB | ✅ 98.1 |
| idle 水位 | ✅ 32.0（§10.2 spike 为 25.6，换机差异内） |

§10.3 的归因在正式版成立：Next 的 ~21MB 常数项已消掉，且本轮回落稳态比 spike 还低
~27MB（换机 + 正式版路由/静态托管差异，单轮不归因）。**纯网关 / 低 QPS 两场景本轮未重测**
（守卫只放行了默认混合场景的单次授权；纯网关迁移前已达标 67.1，且负载是混合的子集）。

### 11.4 复现

```bash
docker build -t tt:hono .
IMAGE=tt:hono LABEL=hono PORT=30110 bash bench/docker-bench.sh   # :3000 被占的机器必须带 PORT
node bench/recalc-stats-usage.mjs hono
```

### 11.5 同机 A/B：tt:next-base vs tt:hono（回答「CPU 变化」）

§11.2 的跨机限制用基线镜像消除：`tt:next-base` = `git archive HEAD`（迁移前代码），
同一台 31GiB 机器、同一 seed/库、同 flags、同 `PORT=30110`，两轮各一次（单轮）：

| 指标 | tt:next-base | tt:hono | 变化 |
|---|---|---|---|
| **压测期 CPU avg**（cgroup cpuPct） | **105.4%**（max 136） | **91.9%**（max 119） | **−13.5pp / −13%** |
| 单请求 CPU（load avg ÷ rps） | 1.22 %core·s | 0.93 %core·s | **−23.5%** |
| idle CPU（前/后） | 0.2% / 0.9% | 0.1% / 1.6% | 均≈0，噪声内 |
| 吞吐 rps | 86.7 | **98.8** | **+14%** |
| p50 / p95 / p99（ms） | 49.2 / 282.8 / 2173 | 44.7 / 231.8 / **1189** | −9% / −18% / −45% |
| 失败 | 0 / 26013 | 0 / 29661 | 均 fail=0 |
| idle（docker stats） | 46.6 | **32.0** | −31% |
| 压测回落稳态 | 71.4 | **45.6** | **−36%** |
| 回落 anon | 67.0 | **43.1** | −36% |
| 峰值 | 118.7 | 98.1 | −17% |

结论（同机、单轮口径）：**CPU 全面下降**——同负载压测期 −13.5pp，按单请求归一 −23.5%；
同时吞吐 +14%、p99 尾延近腰斩。方向与 §10.3 的归因一致：省掉 Next 运行时的框架开销
（模块图/路由表/proxy 层）不只是省内存，也省每请求的 CPU。
idle CPU 两侧都≈0，无劣化。单轮 + 闭环负载（吞吐越高、压测期 CPU 基数越大）是本节的主要方法学限制。

复现（基线镜像）：

```bash
git archive HEAD | tar -x -C /tmp/tt-next-base && docker build -t tt:next-base /tmp/tt-next-base
IMAGE=tt:next-base LABEL=next-base PORT=30110 bash bench/docker-bench.sh
node bench/recalc-stats-usage.mjs next-base hono
```
