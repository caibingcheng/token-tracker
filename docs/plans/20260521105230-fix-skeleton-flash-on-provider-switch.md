# Fix Skeleton Flash on Provider Switch

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复切换 provider 时 Dashboard 出现 skeleton loading 闪烁的问题，实现数据预保留 + 数字滚动动画的平滑过渡体验。

**Architecture:** 修改 Dashboard.tsx 的 `fetchAll` 函数，增加 `skipLoading` 选项参数。当切换 provider 时（通过 dropdown 选择），调用 `fetchAll({ skipLoading: true })`，避免触发 skeleton loading 状态。旧数据保持显示，新数据回来后 `useAnimatedNumber` hook 自动触发数字滚动动画。

**Tech Stack:** Next.js 14, React, TypeScript, Tailwind CSS

---

## Problem

当前行为：用户在下拉框切换 provider 时，Dashboard 所有模块（StatsCards、DailyUsageChart、Top 5 Models）同时进入 skeleton loading 状态（灰色脉冲条），数据回来后内容重新出现。视觉上产生"黑一下"的闪烁效果。

根因：`handleProviderChange` → `fetchAll()` → `setLoadingStats(true)` 等，无条件触发所有 loading 状态。

## Solution

### Task 1: 修改 fetchAll 支持 skipLoading

**File:** `src/components/Dashboard.tsx`

**Current code (around line 72-167):**

```typescript
const fetchAll = useCallback(async () => {
  if (!isVisibleRef.current || isFetchingRef.current) return;
  isFetchingRef.current = true;

  setLoadingStats(true);   // ← 始终触发
  setLoadingTop5(true);    // ← 始终触发
  setLoadingDaily(true);   // ← 始终触发

  setErrorStats(null);
  setErrorTop5(null);
  setErrorDaily(null);

  try {
    const [statsRes, top5Res, dailyRes] = await Promise.all([
      fetch("/api/stats?groupBy=none&range=all"),
      fetch("/api/stats?groupBy=model"),
      fetch("/api/stats?groupBy=date&range=30d"),
    ]);
    // ... rest of fetch logic
  } finally {
    setLoadingStats(false);
    setLoadingTop5(false);
    setLoadingDaily(false);
    isFetchingRef.current = false;
  }
}, []);
```

**修改后：**

```typescript
const fetchAll = useCallback(async (options?: { skipLoading?: boolean }) => {
  if (!isVisibleRef.current || isFetchingRef.current) return;
  isFetchingRef.current = true;

  // 只有首次加载才显示 skeleton；切换 provider 时 skipLoading
  const isFirstLoad = !statsRef.current && !topModelsRef.current && !dailyDataRef.current;
  if (!options?.skipLoading && isFirstLoad) {
    setLoadingStats(true);
    setLoadingTop5(true);
    setLoadingDaily(true);
  }

  setErrorStats(null);
  setErrorTop5(null);
  setErrorDaily(null);

  try {
    const currentProvider = selectedProviderRef.current;

    const statsUrl = new URL("/api/stats?groupBy=none&range=all", window.location.origin);
    const top5Url = new URL("/api/stats?groupBy=model", window.location.origin);
    const dailyUrl = new URL("/api/stats?groupBy=date&range=30d", window.location.origin);

    if (currentProvider !== "all") {
      statsUrl.searchParams.set("provider", currentProvider);
      top5Url.searchParams.set("provider", currentProvider);
      dailyUrl.searchParams.set("provider", currentProvider);
    }

    const [statsRes, top5Res, dailyRes] = await Promise.all([
      fetch(statsUrl.toString()),
      fetch(top5Url.toString()),
      fetch(dailyUrl.toString()),
    ]);

    // ... rest of existing fetch logic (unchanged)

  } catch (err) {
    // 如果 skipLoading 时出错，需要显示错误但不触发 loading
    console.error("Fetch error:", err);
    setErrorStats("Network error");
    setErrorTop5("Network error");
    setErrorDaily("Network error");
  } finally {
    if (!options?.skipLoading) {
      setLoadingStats(false);
      setLoadingTop5(false);
      setLoadingDaily(false);
    }
    isFetchingRef.current = false;
  }
}, []);
```

**注意：**
- `isFirstLoad` 判断：如果 `statsRef.current` 为 null（即首次加载），显示 skeleton
- `skipLoading` 为 true 时：不设置 loading 状态，finally 中也不清除（因为没有设置过）
- 错误处理：skipLoading 模式下出错，直接显示错误文字，不触发 skeleton

### Task 2: 修改 handleProviderChange 传 skipLoading

**File:** `src/components/Dashboard.tsx`

**Current code：**

```typescript
const handleProviderChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
  const value = e.target.value;
  setSelectedProvider(value);
  selectedProviderRef.current = value;
  fetchAll();
}, [fetchAll]);
```

**修改后：**

```typescript
const handleProviderChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
  const value = e.target.value;
  setSelectedProvider(value);
  selectedProviderRef.current = value;
  fetchAll({ skipLoading: true }); // ← 关键：跳过 skeleton
}, [fetchAll]);
```

### Task 3: 确保首次加载仍显示 skeleton

首次加载（页面刷新或刚打开）时，`statsRef.current` 为 null，`isFirstLoad` 为 true，因此 `skipLoading` 为 false，正常显示 skeleton。这符合现有行为。

### Task 4: 验证 auto-refresh 行为

auto-refresh 通过 `fetchAll()` 调用（无参数），因此 `skipLoading` 为 undefined/false。但 auto-refresh 时 `isFirstLoad` 为 false（因为已有数据），所以也不会显示 skeleton。这是预期行为——auto-refresh 应该静默更新，不闪 skeleton。

## Verification

1. **首次加载：** 页面打开时，显示 skeleton → 数据回来后显示内容 ✅
2. **切换 provider：** 选择新 provider，旧数据保持显示 → 新数据回来后数字滚动动画 ✅
3. **无 skeleton 闪烁：** 切换过程中不出现灰色脉冲条 ✅
4. **auto-refresh：** 启用后，数据静默更新，数字动画滚动 ✅
5. **错误处理：** 网络错误时显示红色错误文字，不触发 skeleton ✅

## 相关文件

- `src/components/Dashboard.tsx` — 核心修改
- `src/hooks/useAnimatedNumber.ts` — 数字动画（已存在）
- `src/components/StatsCards.tsx` — 使用动画 hook（已存在）
- `src/components/DailyUsageChart.tsx` — Summary 动画（已存在）

## 依赖

本计划依赖以下已完成的工作：
- Provider 过滤与匿名化（已完成）
- `useAnimatedNumber` hook（已完成）
- StatsCards / DailyUsageChart / Top 5 Models 数字动画（已完成）

---

## 回滚

如果出现问题：
```bash
git checkout HEAD -- src/components/Dashboard.tsx
```
