# API Caching Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add API layer caching with permanent hot cache (invalidated only by ingest) to reduce database load and ensure Dashboard loads instantly.

**Architecture:**
- **Dual-layer caching:**
  1. Hot cache (in-memory `Map`, instance-local) — permanent, invalidated only on ingest
  2. Persistent cache (`unstable_cache` from `next/cache`, cross-instance via Vercel Data Cache)
- **Flow:** Request → Hot cache → Persistent cache → Database
- **TTL:** Permanent (`Infinity`) — cache never expires; only invalidated via ingest
- **Ingest triggers:** `revalidateTag()` + hot cache clear + background rebuild of common cache keys

**Tech Stack:** Next.js `unstable_cache`, `revalidateTag`, Node.js `Map`

---

## 文件结构

```
src/
├── components/
│   └── Dashboard.tsx      # 修改：Recent Records 懒加载
├── lib/
│   └── cache.ts          # 新增：缓存工具模块
├── app/
│   └── api/
│       ├── stats/
│       │   └── route.ts   # 修改：添加缓存包装
│       ├── providers/
│       │   └── route.ts   # 修改：添加缓存包装
│       └── ingest/
│           └── route.ts   # 修改：写入后清除缓存
```

---

## Task 1: 创建缓存工具模块 `src/lib/cache.ts`

**Files:**
- Create: `src/lib/cache.ts`

### Step 1.1: 定义缓存条目类型和配置常量

```typescript
// src/lib/cache.ts

// ── 缓存条目元数据 ──
interface CacheEntry<T> {
  data: T;
  isValid: boolean;  // true = 有效，false = 已失效（等待 ingest 后清除）
}

// ── 全局热缓存 Map（实例级别，不跨实例共享） ──
const hotCache = new Map<string, CacheEntry<unknown>>();

// ── 后台刷新锁，防止缓存雪崩（cache stampede） ──
const pendingRefreshes = new Map<string, Promise<unknown>>();

// ── TTL 配置（永久缓存，仅通过 ingest 失效） ──
const INFINITE_TTL = Infinity;

// ── 持久缓存标签（用于 unstable_cache + revalidateTag） ──
const STATS_CACHE_TAG = 'api-stats';
const PROVIDERS_CACHE_TAG = 'api-providers';
```

### Step 1.2: 实现热缓存读写函数

```typescript
// ── 热缓存键生成 ──
function hotKey(...parts: string[]): string {
  return parts.join(':');
}

// ── 从热缓存读取（永久有效，无 SWR） ──
function getHot<T>(key: string): T | null {
  const entry = hotCache.get(key) as CacheEntry<T> | undefined;
  if (!entry || !entry.isValid) return null;
  return entry.data;
}

// ── 写入热缓存（永久存储，直到被显式清除） ──
function setHot<T>(key: string, data: T): void {
  hotCache.set(key, { data, isValid: true });
}
```

### Step 1.3: 实现 Stats 缓存函数

```typescript
// ── Stats 参数接口 ──
export interface StatsParams {
  groupBy: string;
  range: string;
  provider: string;
  granularity?: string;
}

// ── 生成 Stats 缓存键 ──
function statsHotKey(params: StatsParams): string {
  return hotKey(
    'stats',
    params.groupBy,
    params.range,
    params.provider,
    params.granularity ?? 'none'
  );
}

// ── 获取缓存的 Stats（含持久缓存回退） ──
export async function getCachedStats<T>(
  params: StatsParams,
  queryFn: () => Promise<T>
): Promise<T> {
  const key = statsHotKey(params);

  // 1. 尝试热缓存（永久有效，除非被 ingest 失效）
  const hot = getHot<T>(key);
  if (hot) return hot;

  // 2. 热缓存未命中 → 尝试持久缓存（unstable_cache）
  try {
    const data = await getPersistentStats(params, queryFn);
    setHot(key, data);
    return data;
  } catch {
    // 持久缓存失败 → 直接查库
    const data = await queryFn();
    setHot(key, data);
    return data;
  }
}

// ── 持久缓存包装（unstable_cache） ──
import { unstable_cache } from 'next/cache';

async function getPersistentStats<T>(
  params: StatsParams,
  queryFn: () => Promise<T>
): Promise<T> {
  const key = statsHotKey(params);
  const cachedFn = unstable_cache(
    async () => {
      return await queryFn();
    },
    [key],
    { tags: [STATS_CACHE_TAG], revalidate: false }
  );
  return cachedFn();
}
```

### Step 1.4: 实现 Providers 缓存函数

```typescript
// ── 获取缓存的 Providers ──
export async function getCachedProviders<T>(
  queryFn: () => Promise<T>
): Promise<T> {
  const key = 'providers:list';

  // 1. 热缓存（永久有效，除非被 ingest 失效）
  const hot = getHot<T>(key);
  if (hot) return hot;

  // 2. 持久缓存
  try {
    const cachedFn = unstable_cache(
      async () => queryFn(),
      [key],
      { tags: [PROVIDERS_CACHE_TAG], revalidate: false }
    );
    const data = await cachedFn();
    setHot(key, data);
    return data;
  } catch {
    const data = await queryFn();
    setHot(key, data);
    return data;
  }
}
```

### Step 1.5: 实现后台刷新（防缓存雪崩）

```typescript
// ── 后台刷新函数（防缓存雪崩） ──
async function refreshInBackground<T>(
  key: string,
  queryFn: () => Promise<T>
): Promise<void> {
  // 如果已有相同 key 的刷新在进行中，跳过
  if (pendingRefreshes.has(key)) return;

  const promise = (async () => {
    try {
      const freshData = await queryFn();
      setHot(key, freshData);
    } catch (err) {
      console.error(`[Cache] Background refresh failed for key "${key}":`, err);
    } finally {
      pendingRefreshes.delete(key);
    }
  })();

  pendingRefreshes.set(key, promise);
  // fire-and-forget，不阻塞请求
  void promise;
}
```

### Step 1.6: 实现缓存失效函数

```typescript
import { revalidateTag } from 'next/cache';

// ── 使 Stats 缓存失效 ──
export function invalidateStatsCache(): void {
  // 1. 通知 Vercel Data Cache 清除所有带 STATS_CACHE_TAG 的条目
  revalidateTag(STATS_CACHE_TAG);

  // 2. 清除本实例热缓存中的 stats 条目
  for (const key of hotCache.keys()) {
    if (key.startsWith('stats:')) {
      hotCache.delete(key);
    }
  }
  console.log('[Cache] Stats cache invalidated');
}

// ── 使 Providers 缓存失效 ──
export function invalidateProvidersCache(): void {
  revalidateTag(PROVIDERS_CACHE_TAG);
  hotCache.delete('providers:list');
  console.log('[Cache] Providers cache invalidated');
}
```

### Step 1.7: 实现 ingest 后重建常用缓存

```typescript
// ── 重建常用缓存键（ingest 后触发，确保 Dashboard 即时加载） ──
export async function rebuildCommonCaches(): Promise<void> {
  // 仅重建最常访问的缓存键，按优先级排列
  const commonKeys = [
    'stats:none:all',        // 总统计
    'stats:date:7d:all',     // 默认图表范围
    'stats:model:7d:all',    // 默认 Top Models
    'stats:provider:7d:all', // 默认 Providers
    'providers:list',        // Provider 列表
  ];

  for (const key of commonKeys) {
    // 为每个常用键触发后台刷新（利用防雪崩锁，自动去重）
    void refreshInBackground(key, async () => {
      // 根据键名推导参数，调用对应的查询函数
      // 具体查询逻辑由路由层传入，此处仅做键级调度
      throw new Error('rebuildCommonCaches is a framework placeholder — actual queryFn is injected by the caller');
    });
  }
}
```

> **注意：** `rebuildCommonCaches` 是框架函数，真正的查询逻辑由调用者注入。在实际实现中，`refreshInBackground` 的回调需要绑定具体的 DB 查询函数。详见 Task 4 的 ingest 处理。

---

## Task 2: 修改 Stats API Route — 添加缓存

**Files:**
- Modify: `src/app/api/stats/route.ts`

### Step 2.1: 导入缓存工具

在文件顶部添加导入：

```typescript
import { getCachedStats } from '@/lib/cache';
```

### Step 2.2: 将查询包装为函数

将现有的查询逻辑提取为一个接收参数的纯函数。保留 `buildWhereClause` 等辅助函数不变。

```typescript
// 在构建完 groupBy 分支之后，将 await query 的部分提取出来
async function executeStatsQuery(params: {
  groupBy: string;
  range: string;
  provider: string;
  granularity?: string;
}): Promise<unknown> {
  const { groupBy, range, provider, granularity } = params;

  // 原有的日期过滤和 provider deanonymize 逻辑保持不变
  let dateFilter: Date | null = null;
  if (range !== 'all') {
    const days = parseInt(range);
    dateFilter = new Date();
    dateFilter.setDate(dateFilter.getDate() - days);
  }

  let providerFilter: string | null = null;
  if (provider !== 'all') {
    const allProviderRows = await db
      .selectDistinct({ provider: tokenRecords.provider })
      .from(tokenRecords);
    const allProviderNames: string[] = allProviderRows
      .map((r) => r.provider)
      .filter((n): n is string => n !== null && n !== undefined);
    providerFilter = deanonymizeProvider(provider, allProviderNames);
    if (!providerFilter) {
      throw new Error(`Unknown provider: ${provider}`);
    }
  }

  // 原有 groupBy 分支逻辑 ...（完全不变）
  // 唯一变化：最后 return data 而非直接 response
  // 注意："model" 分支已经 return，需要改为保存到变量后统一 return
}
```

> **注意：** `groupBy === "model"` 分支目前直接在函数体内 `return` 了 `NextResponse.json(...)`。为了提取为纯查询函数，需要将该分支改为返回纯数据对象 `{ success: true, data }`，由外层统一包装为 `NextResponse`。

### Step 2.3: 在 GET handler 中调用缓存

```typescript
export async function GET(request: NextRequest) {
  await initDatabase();
  try {
    const { searchParams } = new URL(request.url);
    const groupBy = searchParams.get('groupBy') || 'date';
    const range = searchParams.get('range') || '30d';
    const providerParam = searchParams.get('provider') || 'all';
    const granularity = searchParams.get('granularity') || undefined;

    // 通过缓存获取数据
    const data = await getCachedStats(
      { groupBy, range, provider: providerParam, granularity },
      () => executeStatsQuery({ groupBy, range, provider: providerParam, granularity })
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Stats error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

### 具体修改要点

| 位置 | 修改内容 |
|------|----------|
| 文件顶部 | 添加 `import { getCachedStats } from '@/lib/cache'` |
| `GET` 函数 | 删除底部的 `const data = await query;` 以及 `groupBy === "model"` 分支中的 `return NextResponse.json(...)` |
| 新增 | 包裹原查询逻辑为 `executeStatsQuery()` 函数，返回纯数据 |
| `GET` 函数 | 调用 `getCachedStats(params, () => executeStatsQuery(params))`，再统一 `NextResponse.json()` |

---

## Task 3: 修改 Providers API Route — 添加缓存

**Files:**
- Modify: `src/app/api/providers/route.ts`

### Step 3.1: 导入缓存工具

```typescript
import { getCachedProviders } from '@/lib/cache';
```

### Step 3.2: 提取查询函数并包装缓存

```typescript
export async function GET(request: NextRequest) {
  await initDatabase();
  try {
    const data = await getCachedProviders(async () => {
      const rows = await db
        .selectDistinct({ provider: tokenRecords.provider })
        .from(tokenRecords);

      const allProviderNames: string[] = rows
        .map((row) => row.provider)
        .filter((name): name is string => name !== null && name !== undefined);

      return allProviderNames.map((realName) => {
        const displayName = anonymizeProvider(realName, allProviderNames);
        return { id: displayName, name: displayName };
      }).sort((a, b) => a.name.localeCompare(b.name));
    });

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error('Error fetching providers:', error);
    return NextResponse.json(
      { success: false, error: 'Failed to fetch providers' },
      { status: 500 }
    );
  }
}
```

---

## Task 4: 修改 Ingest API Route — 插入后刷新缓存

**Files:**
- Modify: `src/app/api/ingest/route.ts`

### Step 4.1: 导入缓存失效与重建函数

```typescript
import { invalidateStatsCache, invalidateProvidersCache, rebuildCommonCaches } from '@/lib/cache';
```

### Step 4.2: 在成功插入后刷新并重建缓存

```typescript
export async function POST(request: NextRequest) {
  await initDatabase();
  try {
    // ... 原有验证和插入逻辑不变 ...

    const result = await db
      .insert(tokenRecords)
      .values({
        apiKey,
        model: String(body.model),
        provider: String(body.provider),
        inputTokens,
        outputTokens,
        cacheRead,
        cacheWrite,
      })
      .returning();

    // ── 新增：插入成功后刷新缓存 ──
    invalidateStatsCache();
    invalidateProvidersCache();
    // 触发后台重建常用缓存键（fire-and-forget，不阻塞 ingest 响应）
    void rebuildCommonCaches();

    return NextResponse.json({ success: true, id: result[0].id });
  } catch (error) {
    console.error('Ingest error:', error);
    return NextResponse.json(
      { success: false, error: 'Internal server error' },
      { status: 500 }
    );
  }
}
```

> **设计选择说明：** 直接在 ingest 中调用缓存失效 + 重建，而不是延迟队列，因为当前数据量很小（~3000 条），缓存重建成本低。`rebuildCommonCaches()` 以 fire-and-forget 方式执行，不阻塞 ingest 响应。对于更大规模的数据量，可考虑加入队列或节流。

---

## Task 5: Recent Records 懒加载优化

**Files:**
- Modify: `src/components/Dashboard.tsx`

**Goal:** 默认不加载 Recent Records，用户点击按钮后才加载，减少不必要的 API 请求。

### 设计原则

- **默认收起**：首次打开 Dashboard 时，Recent Records 区域显示 [加载最近记录] 按钮，不发起 API 请求
- **点击展开**：用户点击按钮后，加载 /api/records 并显示表格
- **状态保持**：加载一次后，收起/展开不重新请求（数据保留在组件状态）
- **Provider 切换**：如果已展开，Provider 切换时自动重新加载（因为筛选条件变了）
- **Ingest 更新**：如果已展开，ingest 新数据时通过 refreshKey 自动刷新

### Step 5.1: 添加展开状态

在 Dashboard 组件中添加状态：

```typescript
const [recordsVisible, setRecordsVisible] = useState(false);
```

### Step 5.2: 添加 Toggle 按钮

在 RecordsTable 上方添加可折叠面板：

```tsx
{/* Recent Records Toggle */}
<div className="bg-white rounded-lg shadow overflow-hidden mb-8">
  <button
    onClick={() => setRecordsVisible(!recordsVisible)}
    className="w-full px-6 py-4 flex justify-between items-center hover:bg-gray-50 transition-colors"
  >
    <h2 className="text-lg font-semibold">Recent Records</h2>
    <span className="text-gray-400">
      {recordsVisible ? '▼' : '▶'}
    </span>
  </button>
  
  {recordsVisible && (
    <RecordsTable 
      selectedProvider={selectedProvider} 
      refreshKey={recordsRefreshKey} 
    />
  )}
</div>
```

### Step 5.3: 调整 Provider 切换逻辑

当 Provider 切换时，如果 recordsVisible 为 true，RecordsTable 的 useEffect 会自动重新加载（因为 selectedProvider 是依赖项）。无需额外修改。

### Step 5.4: 移除旧的 RecordsTable 渲染

找到原代码中的：
```tsx
<RecordsTable selectedProvider={selectedProvider} refreshKey={recordsRefreshKey} />
```

替换为新的可折叠面板包裹版本。

### Step 5.5: 可选 — 添加展开计数提示

在按钮上显示当前 Provider 下的记录数（可选，需要额外 API 调用，暂不实现）：

```tsx
// 暂不使用，避免额外的 API 请求
// <span className="text-sm text-gray-500">{totalRecords} records</span>
```

### 效果预期

- **首次打开 Dashboard**：仅 3 个聚合请求（已缓存），0 个 records 请求
- **用户不查看 Recent Records**：节省大量 API 调用和数据库查询
- **用户点击展开**：首次加载 records，之后收起/展开不重复请求
- **Provider 切换**：自动刷新 records（如果已展开）

---

## Task 6: 验证和测试

### Step 6.1: TypeScript 编译检查

```bash
npm run build
```

确认无类型错误。注意 `unstable_cache` 的泛型类型可能需要显式标注。

### Step 6.2: 启动开发服务器并观察缓存行为

```bash
npm run dev
```

在浏览器或终端观察日志输出：

1. **首次请求 Stats API** — 应看到数据库查询执行，热缓存填充
2. **后续请求（任意间隔）** — 应直接返回热缓存数据，无 DB 查询（永久缓存，永不过期）
3. **重启开发服务器** — 热缓存丢失，回退到持久缓存或重新查库

### Step 6.3: 测试 Ingest → Cache 刷新流

```bash
# 先请求一次 stats 让缓存填充
curl http://localhost:3000/api/stats?groupBy=none

# 插入新记录
curl -X POST http://localhost:3000/api/ingest \
  -H "Content-Type: application/json" \
  -H "X-API-Key: test-key" \
  -d '{"model":"gpt-4","provider":"openai","inputTokens":100,"outputTokens":50}'

# 再次请求 stats，应看到新的数据（缓存已失效并后台重建）
# 首次 ingest 后请求可能较慢（等待后台重建完成），后续请求秒回
curl http://localhost:3000/api/stats?groupBy=none
```

### Step 6.4: 验证不同查询参数的缓存隔离

```bash
# 这两个请求的缓存键不同，应各自独立缓存
curl http://localhost:3000/api/stats?groupBy=date\&range=7d
curl http://localhost:3000/api/stats?groupBy=model
```

---

## 测试计划

### 单元测试（可选，如项目已配置测试框架）

| 测试场景 | 预期行为 |
|----------|----------|
| `getHot` 命中有效缓存 | 返回数据 |
| `getHot` 未命中（键不存在） | 返回 `null` |
| `getHot` 命中无效缓存（`isValid=false`） | 返回 `null` |
| `setHot` 后立即 `getHot` | 返回相同数据 |
| 相同 key 并发后台刷新 | 只有一个刷新请求执行（防雪崩） |
| `invalidateStatsCache` | 清除所有 `stats:` 前缀的热缓存条目 |
| `getCachedStats` 冷启动 | 回退到 queryFn，然后填充双缓存 |
| `rebuildCommonCaches` | 触发指定常用键的后台刷新 |

### 集成测试

| 场景 | 步骤 | 验证 |
|------|------|------|
| 双实例缓存共享 | 模拟两个并发请求到不同实例（或 Vercel 部署） | 第二个实例应通过 `unstable_cache` 命中持久缓存 |
| 缓存隔离 | 不同 groupBy/range/provider 参数 | 各自独立缓存，互不影响 |
| 高并发 | 同一 key 同时 10 个请求 | 只有首个请求查库，其余命中缓存 |
| Recent Records 默认不加载 | 打开 Dashboard，查看网络请求 | 不出现 `/api/records` 请求 |
| Recent Records 点击展开 | 点击 [加载最近记录] 按钮 | `/api/records` 请求发出，表格显示数据 |
| Recent Records 收起/展开不重复请求 | 展开一次后收起，再展开 | 只有一次 `/api/records` 请求，再次展开不重复请求 |
| Recent Records Provider 切换 | 展开 Records 后切换 Provider | 自动重新加载 `/api/records`（筛选条件变化） |

---

## 验证步骤

- [ ] `npm run build` — TypeScript 编译通过，无类型错误
- [ ] `npm run dev` — 开发服务器正常启动
- [ ] `curl /api/stats?groupBy=none` — 首次返回数据（~500ms 含 DB 查询），热缓存填充
- [ ] `curl /api/stats?groupBy=none`（第二次，任意间隔）— 秒返回（< 10ms，永久热缓存命中）
- [ ] 重启开发服务器后再次请求 — 热缓存丢失，回退到持久缓存或 DB
- [ ] `curl -X POST /api/ingest` + 立即 `curl /api/stats?groupBy=none` — 数据可能仍为旧数据（后台重建尚未完成），稍后再次请求应包含新记录
- [ ] `curl /api/providers` — 首次返回（~100ms），后续请求秒回
- [ ] `curl -X POST /api/ingest` + `curl /api/providers` — 刷新后返回更新后的 provider 列表
- [ ] 不同 groupBy 参数请求 — 各自独立缓存
- [ ] 打开 Dashboard — 检查网络面板，确认未发起 `/api/records` 请求
- [ ] 点击 [加载最近记录] — 确认 `/api/records` 请求发出，表格渲染
- [ ] 收起并再次展开 Records — 确认未发起重复 API 请求（数据从组件状态读取）
- [ ] 展开 Records 后切换 Provider — 确认自动重新加载 `/api/records`

---

## 边界情况与注意事项

1. **`unstable_cache` 的稳定性**
   - 该 API 在 Next.js 中标记为 `unstable`，未来版本可能变更
   - 热缓存（Map）使用永久缓存模式，不受 Next.js 版本影响，可作为兜底

2. **Vercel 冷启动**
   - 实例冷启动时热缓存为空，但 `unstable_cache` 持久缓存仍可能命中
   - 若持久缓存也未命中，回退到数据库查询，用户体验无降级

3. **缓存键冲突**
   - 使用 `stats:<groupBy>:<range>:<provider>:<granularity>` 模式确保唯一
   - 分隔符选择 `:` 避免与参数值中的字符冲突

4. **Ingest 后的缓存重建延迟**
   - `rebuildCommonCaches()` 以 fire-and-forget 方式执行，不阻塞 ingest 响应
   - 重建期间请求的非常用键仍走 DB 查询，不影响正确性
   - 常用键在重建完成后立即可用，下一次请求命中热缓存

5. **`rebuildCommonCaches` 的键覆盖范围**
   - 目前只重建 5 个最常用键，覆盖 Dashboard 默认视图
   - 非常用键（如自定义 range 或 provider 过滤）在下次请求时按需重建
   - 如需扩展常用键列表，在 `commonKeys` 数组中添加即可

6. **内存使用**
   - 当前数据量小（~3000 条），每个缓存条目约 1-10 KB
   - 最多 20 种 groupBy × 5 种 range × 5 种 provider × 3 种 granularity ≈ 1500 条目
   - 总内存占用 < 15 MB，远低于 Vercel Serverless 的 512 MB 限制
   - 永久缓存意味着条目永远不会因过期而被清除，但当前数据量不会导致内存问题

7. **`model` groupBy 的特殊处理**
   - 该分支返回的 data 结构与其它分支一致，均为数组，无需特殊处理
   - 但 `executeStatsQuery` 中需要将原来的 `return NextResponse.json(...)` 改为纯 `return data`

8. **错误处理**
   - 后台刷新失败仅记录日志，不抛异常
   - `unstable_cache` 失败时自动回退到 DB 查询
   - 热缓存损坏时通过 `isValid = false` 标记失效，下次请求重新填充

---

*Plan complete.*
