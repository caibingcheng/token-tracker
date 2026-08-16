import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadPriceMap, invalidatePriceCache, computeModelCost, type CostTokens } from "./pricing";
import type { ModelPricing } from "@/lib/cost-utils";

const rowsMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/db", () => ({
  initDatabase: vi.fn(async () => {}),
  db: {
    select: () => ({ from: () => Promise.resolve(rowsMock()) }),
  },
  modelPricesTable: {},
}));

vi.mock("@/lib/db/cache", () => ({
  withSkipCache: vi.fn(async (fn: () => Promise<any>) => fn()),
}));

const TOKENS: CostTokens = {
  inputTokens: 1_000_000,
  cacheRead: 500_000,
  cacheWrite: 200_000,
  outputTokens: 800_000,
};

beforeEach(() => {
  invalidatePriceCache();
  rowsMock.mockReset();
});

describe("loadPriceMap", () => {
  it("falls back cache prices to input price when NULL", async () => {
    rowsMock.mockResolvedValue([
      { model: "claude-x", inputPrice: 3, outputPrice: 15, cacheReadPrice: null, cacheWritePrice: null, source: "models.dev", modelsDevId: "a/claude-x", updatedAt: "t" },
      { model: "gpt-x", inputPrice: 2, outputPrice: 8, cacheReadPrice: 0.5, cacheWritePrice: 1, source: "manual", modelsDevId: null, updatedAt: "t" },
    ]);
    const map = await loadPriceMap();
    const claude = map.get("claude-x")!;
    expect(claude.cacheReadPrice).toBe(3);
    expect(claude.cacheWritePrice).toBe(3);
    const gpt = map.get("gpt-x")!;
    expect(gpt.cacheReadPrice).toBe(0.5);
    expect(gpt.cacheWritePrice).toBe(1);
  });

  it("caches the map across calls", async () => {
    rowsMock.mockResolvedValue([]);
    await loadPriceMap();
    await loadPriceMap();
    expect(rowsMock).toHaveBeenCalledTimes(1);
  });

  it("reloads after invalidatePriceCache", async () => {
    rowsMock.mockResolvedValue([]);
    await loadPriceMap();
    invalidatePriceCache();
    await loadPriceMap();
    expect(rowsMock).toHaveBeenCalledTimes(2);
  });
});

describe("computeModelCost", () => {
  const priceMap = new Map<string, ModelPricing>([
    [
      "gpt-x",
      {
        canonicalId: "gpt-x",
        displayName: "gpt-x",
        inputPrice: 2,
        cacheReadPrice: 0.5,
        cacheWritePrice: 1,
        outputPrice: 8,
      },
    ],
  ]);

  it("computes cost from per-million prices", () => {
    const agg = computeModelCost("gpt-x", TOKENS, priceMap);
    expect(agg.inputCost).toBe(2);
    expect(agg.cacheReadCost).toBe(0.25);
    expect(agg.cacheWriteCost).toBe(0.2);
    expect(agg.outputCost).toBe(6.4);
    expect(agg.totalCost).toBeCloseTo(8.85);
  });

  it("returns zero cost for unpriced models", () => {
    const agg = computeModelCost("unknown", TOKENS, priceMap);
    expect(agg.totalCost).toBe(0);
    expect(agg.effectiveTokens).toBe(2_500_000);
  });
});
