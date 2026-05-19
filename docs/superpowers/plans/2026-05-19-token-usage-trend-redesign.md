# Token Usage Trend Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 重构 Token Usage Trend 为按模型分组的堆叠柱状图，修正 Total Input 统计逻辑（包含 cacheRead），并优化 StatsCards 和 RecordsTable 的缓存展示。

**Architecture:** 
- API 层调整聚合逻辑，新增 `groupBy=date-model` 支持按模型+日期分组
- 前端新增 `ModelTrends` 组件替代 `TrendChart`，每个模型独立区块展示请求次数+Token 堆叠柱状图
- StatsCards 中 Total Input 展示 Cached/Uncached 细分

**Tech Stack:** Next.js 14, React 18, TypeScript, Tailwind CSS, Recharts 2.12, Drizzle ORM, PostgreSQL

---

## File Structure

| File | Action | Responsibility |
|------|--------|----------------|
| `src/app/api/stats/route.ts` | Modify | 调整聚合字段（Total Input 含 cacheRead），新增 `date-model` 分组 |
| `src/components/StatsCards.tsx` | Modify | Total Input 内部展示 Cached/Uncached 细分，新增 Cache Write 卡片 |
| `src/components/ModelTrends.tsx` | Create | 替代 TrendChart，按模型分组展示堆叠柱状图+请求次数图 |
| `src/components/Dashboard.tsx` | Modify | 用 ModelTrends 替换 TrendChart，保留 range 选择器 |
| `src/components/RecordsTable.tsx` | Modify | Cache 列拆分为 Cache Read 和 Cache Write |
| `src/components/TrendChart.tsx` | Delete | 废弃，由 ModelTrends 替代 |

---

## Data Flow

### API Response Format (`groupBy=date-model`)

```json
{
  "success": true,
  "data": [
    {
      "group": "2026-05-05",
      "model": "deepseek-v4-pro",
      "totalInput": 50000,
      "totalInputCached": 5000,
      "totalInputUncached": 45000,
      "totalOutput": 20000,
      "totalCacheWrite": 1000,
      "count": 50
    }
  ]
}
```

### Frontend Grouping

前端按 `model` 字段分组，为每个模型渲染独立区块：
- 每个模型一个 `group` → 按日期排序的数组
- 左侧图表：`count` 随日期变化（线图/面积图）
- 右侧图表：堆叠柱状图（Input Cached / Input Uncached / Output）

---

## Task 1: API 层 - 调整聚合逻辑并新增 date-model 分组

**Files:**
- Modify: `src/app/api/stats/route.ts`

**Context:**
当前 `totalInput` 仅统计 `SUM(inputTokens)`，未包含 `cacheRead`。参考图中 Input 分为"命中缓存"和"未命中缓存"两段，Total Input 应为两者之和。

**改动点：**
1. `groupBy=none` 和 `groupBy=date` 中：
   - `totalInput` → `SUM(inputTokens) + SUM(cacheRead)`
   - 新增 `totalInputCached` → `SUM(cacheRead)`
   - 新增 `totalInputUncached` → `SUM(inputTokens)`
2. 新增 `groupBy=date-model` 分支，同时按日期和模型分组

- [ ] **Step 1: 修改 `groupBy=none` 聚合字段**

```typescript
// 原代码（约 line 24-31）
// totalInput: sql<number>`SUM(${tokenRecords.inputTokens})`,
// 改为：
totalInput: sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
```

- [ ] **Step 2: 修改 `groupBy=date` 聚合字段**

```typescript
// 同样修改 totalInput，并新增 totalInputCached / totalInputUncached
```

- [ ] **Step 3: 新增 `groupBy=date-model` 分支**

```typescript
} else if (groupBy === "date-model") {
  const granularity = searchParams.get("granularity") || "day";
  let dateFormat: string;
  if (granularity === "week") {
    dateFormat = "YYYY-WW";
  } else if (granularity === "month") {
    dateFormat = "YYYY-MM";
  } else {
    dateFormat = "YYYY-MM-DD";
  }
  const groupExpr = sql<string>`TO_CHAR(${tokenRecords.createdAt}, ${sql.raw(`'${dateFormat}'`)})`;
  
  query = db
    .select({
      group: groupExpr,
      model: tokenRecords.model,
      totalInput: sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
      totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
      totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
      totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
      totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
      count: sql<number>`COUNT(*)`,
    })
    .from(tokenRecords)
    .groupBy(groupExpr, tokenRecords.model)
    .orderBy(groupExpr, tokenRecords.model);

  if (dateFilter) {
    query = query.where(
      sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
    );
  }
}
```

- [ ] **Step 4: Commit**

```bash
git add src/app/api/stats/route.ts
git commit -m "feat(api): adjust totalInput to include cacheRead, add date-model groupBy"
```

---

## Task 2: StatsCards - Total Input 细分展示

**Files:**
- Modify: `src/components/StatsCards.tsx`

**改动点：**
1. Stats 接口增加 `totalInputCached` 和 `totalInputUncached`
2. Total Input 卡片内部展示 Cached / Uncached 子标签
3. 新增 Cache Write 卡片（替换原来的 Total Cache）
4. 卡片顺序：Total Input → Total Output → Cache Write → Total Requests

- [ ] **Step 1: 更新 Stats 接口**

```typescript
interface Stats {
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  count: number;
}
```

- [ ] **Step 2: 更新 fetch 后数据处理**

```typescript
setStats({
  totalInput: Number(item.totalInput || 0),
  totalOutput: Number(item.totalOutput || 0),
  totalInputCached: Number(item.totalInputCached || 0),
  totalInputUncached: Number(item.totalInputUncached || 0),
  totalCacheWrite: Number(item.totalCacheWrite || 0),
  count: Number(item.count || 0),
});
```

- [ ] **Step 3: 更新 cards 数组和渲染逻辑**

```typescript
const cards = [
  { 
    label: "Total Input", 
    value: stats?.totalInput || 0, 
    color: "blue",
    breakdown: [
      { label: "Cached", value: stats?.totalInputCached || 0 },
      { label: "Uncached", value: stats?.totalInputUncached || 0 },
    ]
  },
  { label: "Total Output", value: stats?.totalOutput || 0, color: "green" },
  { label: "Cache Write", value: stats?.totalCacheWrite || 0, color: "purple" },
  { label: "Total Requests", value: stats?.count || 0, color: "orange" },
];
```

- [ ] **Step 4: 更新渲染，为 Total Input 卡片增加 breakdown 展示**

```tsx
<div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-8">
  {cards.map((card) => (
    <div key={card.label} className="bg-white rounded-lg shadow p-6">
      <h3 className="text-sm font-medium text-gray-500">{card.label}</h3>
      <p className="text-2xl font-bold mt-2">{formatNumber(card.value)}</p>
      {card.breakdown && (
        <div className="mt-3 pt-3 border-t border-gray-100 grid grid-cols-2 gap-2">
          {card.breakdown.map((item) => (
            <div key={item.label}>
              <p className="text-xs text-gray-400">{item.label}</p>
              <p className="text-sm font-semibold text-gray-700">{formatNumber(item.value)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  ))}
</div>
```

- [ ] **Step 5: Commit**

```bash
git add src/components/StatsCards.tsx
git commit -m "feat(stats): show cached/uncached breakdown in Total Input card, add Cache Write"
```

---

## Task 3: ModelTrends 组件 - 按模型分组的堆叠柱状图

**Files:**
- Create: `src/components/ModelTrends.tsx`

**功能：**
- 请求 `/api/stats?groupBy=date-model&range={range}`
- 按 `model` 分组数据
- 每个模型渲染一个区块，包含：
  - 模型名称 + 总请求次数
  - 左侧：请求次数趋势（AreaChart 或 LineChart）
  - 右侧：Token Usage 堆叠柱状图（BarChart）

- [ ] **Step 1: 创建 ModelTrends.tsx 文件**

```tsx
"use client";

import { useEffect, useState, useMemo } from "react";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  LineChart,
  Line,
  AreaChart,
  Area,
} from "recharts";

interface ModelTrendData {
  group: string;
  model: string;
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalOutput: number;
  totalCacheWrite: number;
  count: number;
}

interface ModelGroup {
  model: string;
  totalRequests: number;
  data: ModelTrendData[];
}

export default function ModelTrends({ range = "30d" }: { range?: string }) {
  const [rawData, setRawData] = useState<ModelTrendData[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/api/stats?groupBy=date-model&range=${range}`)
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((result) => {
        if (result.success) {
          setRawData(result.data);
        } else {
          setError(result.error || "Failed to load trend data");
        }
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [range]);

  const modelGroups = useMemo(() => {
    const grouped = new Map<string, ModelTrendData[]>();
    rawData.forEach((item) => {
      if (!grouped.has(item.model)) {
        grouped.set(item.model, []);
      }
      grouped.get(item.model)!.push(item);
    });
    
    const result: ModelGroup[] = [];
    grouped.forEach((data, model) => {
      data.sort((a, b) => a.group.localeCompare(b.group));
      const totalRequests = data.reduce((sum, d) => sum + d.count, 0);
      result.push({ model, totalRequests, data });
    });
    
    return result;
  }, [rawData]);

  if (loading) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <h3 className="text-lg font-semibold mb-4">Token Usage by Model</h3>
        <div className="h-[300px] bg-gray-100 rounded animate-pulse"></div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <h3 className="text-lg font-semibold mb-4">Token Usage by Model</h3>
        <p className="text-red-600">Error: {error}</p>
      </div>
    );
  }

  if (modelGroups.length === 0) {
    return (
      <div className="bg-white rounded-lg shadow p-6 mb-8">
        <h3 className="text-lg font-semibold mb-4">Token Usage by Model</h3>
        <p className="text-gray-500">No data available</p>
      </div>
    );
  }

  return (
    <div className="space-y-8">
      <h3 className="text-lg font-semibold">Token Usage by Model</h3>
      {modelGroups.map(({ model, totalRequests, data }) => (
        <div key={model} className="bg-white rounded-lg shadow p-6">
          <div className="mb-4">
            <h4 className="text-base font-semibold">{model}</h4>
            <p className="text-sm text-gray-500">API Requests: {totalRequests.toLocaleString()}</p>
          </div>
          
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            {/* Left: Request Count Trend */}
            <div>
              <ResponsiveContainer width="100%" height={250}>
                <AreaChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="group" />
                  <YAxis />
                  <Tooltip />
                  <Area 
                    type="monotone" 
                    dataKey="count" 
                    stroke="#3B82F6" 
                    fill="#3B82F6" 
                    fillOpacity={0.3}
                    name="Requests"
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>
            
            {/* Right: Token Usage Stacked Bar */}
            <div>
              <ResponsiveContainer width="100%" height={250}>
                <BarChart data={data}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="group" />
                  <YAxis />
                  <Tooltip />
                  <Legend />
                  <Bar dataKey="totalInputCached" stackId="input" fill="#93C5FD" name="Input (Cached)" />
                  <Bar dataKey="totalInputUncached" stackId="input" fill="#3B82F6" name="Input (Uncached)" />
                  <Bar dataKey="totalOutput" fill="#1E40AF" name="Output" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}
```

- [ ] **Step 2: Commit**

```bash
git add src/components/ModelTrends.tsx
git commit -m "feat(trends): add ModelTrends component with stacked bar chart per model"
```

---

## Task 4: Dashboard - 替换 TrendChart 为 ModelTrends

**Files:**
- Modify: `src/components/Dashboard.tsx`
- Delete: `src/components/TrendChart.tsx`

- [ ] **Step 1: 修改 Dashboard.tsx**

```tsx
"use client";

import { useState } from "react";
import StatsCards from "./StatsCards";
import ModelTrends from "./ModelTrends";
import ModelDistributionChart from "./ModelDistributionChart";
import ProviderDistributionChart from "./ProviderDistributionChart";
import RecordsTable from "./RecordsTable";

export default function Dashboard() {
  const [range, setRange] = useState("30d");

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Token Tracker Dashboard</h1>
          <select
            value={range}
            onChange={(e) => setRange(e.target.value)}
            className="px-4 py-2 border rounded-lg"
          >
            <option value="7d">Last 7 Days</option>
            <option value="30d">Last 30 Days</option>
            <option value="90d">Last 90 Days</option>
            <option value="all">All Time</option>
          </select>
        </div>

        <StatsCards />
        <ModelTrends range={range} />

        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 mb-8">
          <ModelDistributionChart />
          <ProviderDistributionChart />
        </div>

        <RecordsTable />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: 删除 TrendChart.tsx**

```bash
rm src/components/TrendChart.tsx
```

- [ ] **Step 3: Commit**

```bash
git add src/components/Dashboard.tsx
git rm src/components/TrendChart.tsx
git commit -m "refactor(dashboard): replace TrendChart with ModelTrends"
```

---

## Task 5: RecordsTable - 拆分 Cache 列

**Files:**
- Modify: `src/components/RecordsTable.tsx`

**改动点：**
1. 表头：将 `Cache` 列拆分为 `Cache Read` 和 `Cache Write`
2. 表格数据：分别显示 `record.cacheRead` 和 `record.cacheWrite`

- [ ] **Step 1: 更新表头**

```tsx
<thead className="bg-gray-50">
  <tr>
    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input (Uncached)</th>
    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input (Cached)</th>
    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Output</th>
    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cache Write</th>
  </tr>
</thead>
```

- [ ] **Step 2: 更新表格行渲染**

```tsx
<tbody className="divide-y divide-gray-200">
  {records.map((record) => (
    <tr key={record.id}>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
        {formatDate(record.createdAt)}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{record.model}</td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">{record.provider}</td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
        {formatNumber(record.inputTokens)}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
        {formatNumber(record.cacheRead)}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
        {formatNumber(record.outputTokens)}
      </td>
      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right">
        {formatNumber(record.cacheWrite)}
      </td>
    </tr>
  ))}
</tbody>
```

- [ ] **Step 3: Commit**

```bash
git add src/components/RecordsTable.tsx
git commit -m "feat(table): split Cache column into Cache Read and Cache Write"
```

---

## Verification

### 手动测试步骤

1. 启动开发服务器：`npm run dev`
2. 访问 Dashboard 页面
3. **StatsCards 验证：**
   - Total Input 是否等于 Cached + Uncached 之和
   - 是否存在 Cache Write 卡片
4. **ModelTrends 验证：**
   - 是否按模型分组展示
   - 每个模型是否有请求次数图 + Token 堆叠柱状图
   - 堆叠柱状图是否有三段：Input (Cached)、Input (Uncached)、Output
   - 切换 range (7d/30d/90d/all) 是否正常刷新
5. **RecordsTable 验证：**
   - 列是否正确：Input (Uncached)、Input (Cached)、Output、Cache Write
   - 数据是否正确显示

### 预期问题

- `ModelDistributionChart` 和 `ProviderDistributionChart` 仍使用旧的 `groupBy=model` 和 `groupBy=provider` API，这些 API 的 `totalInput` 字段现在包含了 cacheRead，这是正确的行为（与 StatsCards 一致）。
- 如果数据量很大，`groupBy=date-model` 可能返回较多行，但通常模型数量在 10 个以内，日期范围 30 天最多 300 行，性能可接受。

---

## Spec Coverage Check

| 需求 | 对应任务 |
|------|---------|
| Total Input 包含 cacheRead | Task 1 (API), Task 2 (StatsCards) |
| 参考图 UI（堆叠柱状图） | Task 3 (ModelTrends) |
| 按模型分组展示 | Task 3 (ModelTrends), Task 4 (Dashboard) |
| StatsCards Cached/Uncached 细分 | Task 2 (StatsCards) |
| RecordsTable Cache 拆分 | Task 5 (RecordsTable) |
| 英文图例 | Task 3 (ModelTrends) |
| 保留 Cache Write 数据库字段 | 不涉及 schema 变更 |
| 方式 b（所有模型独立区块） | Task 3 (ModelTrends) |
