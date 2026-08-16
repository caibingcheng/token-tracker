import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  resolveStatusElements,
  queryStatusData,
  invalidateStatusCache,
  getStatusCacheKey,
  getCachedStatusData,
  setCachedStatusData,
  checkStatusRateLimit,
  type StatusData,
} from "@/lib/status-query";
import { executeStatsQuery } from "@/lib/stats-query";
import type { StatsQueryResult } from "@/lib/stats-query";
import { deleteSetting } from "@/lib/auth/settings";
import type { StatusPageConfig } from "@/lib/auth/settings";

// 数据面最小化：mock 查询层，断言按需查询与响应裁剪

vi.mock("@/lib/stats-query", async (importOriginal) => {
  const mod = await importOriginal<typeof import("@/lib/stats-query")>();
  return { ...mod, executeStatsQuery: vi.fn() };
});

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-status-query-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
  await deleteSetting("hidden_providers").catch(() => {});
  await deleteSetting("status_page_config").catch(() => {});
  invalidateStatusCache();
  vi.restoreAllMocks();
});

const DEFAULT_ELEMENTS = {
  total: true,
  today: true,
  daily: true,
  heatmap: false,
  hourly: false,
  topModels: false,
  cost: false,
};

function makeConfig(overrides: Partial<StatusPageConfig> = {}): StatusPageConfig {
  const merged = { ...DEFAULT_ELEMENTS, ...(overrides.elements ?? {}) };
  return {
    enabled: true,
    ...overrides,
    elements: merged,
  };
}

function mockQuery(results: Partial<Record<string, StatsQueryResult>>) {
  const mock = vi.mocked(executeStatsQuery);
  mock.mockReset();
  mock.mockImplementation(
    (async (params: { groupBy: string; range: string }) => {
      const key = `${params.groupBy}:${params.range}`;
      return results[key] ?? [];
    }) as typeof executeStatsQuery
  );
}

function calls(): Array<{ groupBy: string; range: string }> {
  const fn = vi.mocked(executeStatsQuery);
  return fn.mock.calls.map((c) => ({ groupBy: c[0].groupBy, range: c[0].range }));
}

describe("resolveStatusElements 元素联动", () => {
  it("hourly 开启时强制 daily 视为开启", () => {
    const elements = resolveStatusElements({ ...DEFAULT_ELEMENTS, daily: false, hourly: true });
    expect(elements.daily).toBe(true);
    expect(elements.hourly).toBe(true);
  });

  it("默认配置原样透传（daily 已开）", () => {
    const elements = resolveStatusElements(DEFAULT_ELEMENTS);
    expect(elements).toEqual(DEFAULT_ELEMENTS);
  });
});

describe("queryStatusData 按需查询与响应裁剪", () => {
  it("默认配置（total/today/daily）：仅 3 条查询，响应不含模型/成本数据", async () => {
    mockQuery({
      "none:all": [{ group: "total", totalInput: 10, totalOutput: 5, totalInputCached: 2, totalInputUncached: 8, totalCacheWrite: 0, count: 3, firstActiveAt: "2026-01-01T00:00:00Z", lastActiveAt: "2026-08-11T00:00:00Z" }] as StatsQueryResult,
      "date:2d": [],
      "date:30d": [],
    });

    const data = await queryStatusData(makeConfig(), 0);

    expect(calls().sort((a, b) => a.range.localeCompare(b.range))).toEqual([
      { groupBy: "date", range: "2d" },
      { groupBy: "date", range: "30d" },
      { groupBy: "none", range: "all" },
    ]);
    expect(data.total).not.toBeNull();
    expect(data.totalDays).toBeGreaterThan(0);
    expect(data.elements.topModels).toBe(false);
    expect(data.elements.cost).toBe(false);
    // 数据面：未启用元素为空数组，不泄露模型
    expect(data.topModels).toEqual([]);
    expect(data.totalTopModels).toEqual([]);
    expect(data.todayModels).toEqual([]);
    expect(data.dailyModels).toEqual({});
    expect(data.heatmap).toEqual([]);
    expect(data.hourly).toEqual([]);
    expect(data.daily).toEqual([]);
  });

  it("cost 开启时追加 model 级查询（date-model 2d/30d + model all）", async () => {
    mockQuery({
      "none:all": [],
      "date:2d": [],
      "date:30d": [],
      "date-model:2d": [],
      "date-model:30d": [],
      "model:all": [],
    });

    await queryStatusData(makeConfig({ elements: { ...DEFAULT_ELEMENTS, cost: true } }), 0);

    const callList = calls();
    expect(callList).toContainEqual({ groupBy: "date-model", range: "2d" });
    expect(callList).toContainEqual({ groupBy: "date-model", range: "30d" });
    expect(callList).toContainEqual({ groupBy: "model", range: "all" });
    // cost 关闭时不应有的查询
    expect(callList.length).toBe(6);
  });

  it("topModels 开启时响应含归一化模型名（含成本），且追加 30d model 查询", async () => {
    mockQuery({
      "none:all": [],
      "date:2d": [],
      "date:30d": [],
      "date-model:2d": [],
      "date-model:30d": [
        { group: "2026-08-10", model: "gpt-4o", provider: "openai", totalInput: 100, totalOutput: 50, totalInputCached: 10, totalInputUncached: 90, totalCacheWrite: 0, count: 2 },
      ],
      "model:all": [],
      "model:30d": [
        { group: "openai/gpt-4o", provider: "openai", totalInput: 100, totalOutput: 50, totalInputCached: 10, totalInputUncached: 90, totalCacheWrite: 0, count: 2 },
      ] as StatsQueryResult,
    });

    const data = await queryStatusData(makeConfig({ elements: { ...DEFAULT_ELEMENTS, topModels: true } }), 0);

    expect(calls()).toContainEqual({ groupBy: "model", range: "30d" });
    expect(data.topModels.length).toBeGreaterThan(0);
    expect(data.topModels[0]!.displayName).toBeTruthy();
    // 每日模型：点击图表某天时可展示该日 Top Models
    expect(data.dailyModels["2026-08-10"]?.length).toBeGreaterThan(0);
  });

  it("heatmap/hourly 开启时执行对应查询", async () => {
    mockQuery({
      "none:all": [],
      "date:2d": [],
      "date:30d": [],
      "date:365d": [],
      "date:30d:hour": [],
    });

    await queryStatusData(
      makeConfig({ elements: { ...DEFAULT_ELEMENTS, heatmap: true, hourly: true } }),
      0
    );

    const callList = calls();
    expect(callList).toContainEqual({ groupBy: "date", range: "365d" });
    // hourly 查询：groupBy date range 30d granularity hour
    expect(
      callList.some((c) => c.groupBy === "date" && c.range === "30d")
    ).toBe(true);
  });

  it("全部元素关闭时：total/today/daily 关闭则无任何查询（空响应）", async () => {
    mockQuery({});
    const data = await queryStatusData(
      makeConfig({
        elements: {
          total: false,
          today: false,
          daily: false,
          heatmap: false,
          hourly: false,
          topModels: false,
          cost: false,
        },
      }),
      0
    );
    expect(calls()).toEqual([]);
    expect(data.total).toBeNull();
    expect(data.daily).toEqual([]);
    expect(data.topModels).toEqual([]);
  });
});

describe("status 响应缓存", () => {
  it("set/get/invalidate 生效", () => {
    const key = getStatusCacheKey(480);
    expect(getCachedStatusData(key)).toBeUndefined();
    const data: StatusData = {
      elements: { ...DEFAULT_ELEMENTS },
      total: null,
      totalDays: 0,
      today: null,
      yesterday: null,
      daily: [],
      heatmap: [],
      hourly: [],
      topModels: [],
      totalTopModels: [],
      todayModels: [],
      dailyModels: {},
      timezoneOffsetMinutes: 480,
    };
    setCachedStatusData(key, data);
    expect(getCachedStatusData(key)).toBe(data);
    invalidateStatusCache();
    expect(getCachedStatusData(key)).toBeUndefined();
  });

  it("tzOffset 不同缓存 key 隔离", () => {
    setCachedStatusData(getStatusCacheKey(0), { timezoneOffsetMinutes: 0 } as StatusData);
    expect(getCachedStatusData(getStatusCacheKey(480))).toBeUndefined();
  });
});

describe("checkStatusRateLimit 固定窗口限流", () => {
  it("窗口内超过 60 次后拒绝", () => {
    const bucket = "test-bucket-rate";
    for (let i = 0; i < 60; i++) {
      expect(checkStatusRateLimit(bucket)).toBe(false);
    }
    expect(checkStatusRateLimit(bucket)).toBe(true);
  });

  it("不同 key 独立计数", () => {
    const a = "bucket-a";
    const b = "bucket-b";
    for (let i = 0; i < 60; i++) {
      checkStatusRateLimit(a);
    }
    expect(checkStatusRateLimit(a)).toBe(true);
    expect(checkStatusRateLimit(b)).toBe(false);
  });
});
