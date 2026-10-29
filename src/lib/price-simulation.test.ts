import { describe, expect, it } from "vitest";
import {
  computeCacheRate,
  normalizeCacheRate,
  parseCacheRateInput,
  parsePriceInput,
  redistributeInputTokens,
  simulatePricing,
} from "./price-simulation";
import type { ModelPricing } from "./cost-utils";

const pricing: ModelPricing = {
  canonicalId: "claude-sonnet-4",
  displayName: "anthropic · claude-sonnet-4",
  inputPrice: 3,
  cacheReadPrice: 0.3,
  cacheWritePrice: 3.75,
  outputPrice: 15,
};

describe("computeCacheRate", () => {
  it("cacheRead / totalInput", () => {
    expect(computeCacheRate(1000, 250)).toBeCloseTo(0.25, 10);
  });

  it("totalInput 为 0 时返回 0", () => {
    expect(computeCacheRate(0, 100)).toBe(0);
  });

  it("cacheRead 超过 totalInput 时钳到 1", () => {
    expect(computeCacheRate(100, 500)).toBe(1);
  });

  it("非法/负数输入兜底为 0", () => {
    expect(computeCacheRate(Number.NaN, 10)).toBe(0);
    expect(computeCacheRate(100, -10)).toBe(0);
  });
});

describe("normalizeCacheRate", () => {
  it("null/undefined/NaN 返回 null（跟随实际）", () => {
    expect(normalizeCacheRate(null)).toBeNull();
    expect(normalizeCacheRate(undefined)).toBeNull();
    expect(normalizeCacheRate(Number.NaN)).toBeNull();
  });

  it("钳到 0..1", () => {
    expect(normalizeCacheRate(-1)).toBe(0);
    expect(normalizeCacheRate(2)).toBe(1);
    expect(normalizeCacheRate(0.42)).toBe(0.42);
  });
});

describe("redistributeInputTokens", () => {
  it("保持 totalInput 不变，按 rate 拆分", () => {
    expect(redistributeInputTokens(1000, 0.2)).toEqual({
      cacheRead: 200,
      uncachedInput: 800,
    });
  });

  it("rate 0 / 1 的边界", () => {
    expect(redistributeInputTokens(1000, 0)).toEqual({
      cacheRead: 0,
      uncachedInput: 1000,
    });
    expect(redistributeInputTokens(1000, 1)).toEqual({
      cacheRead: 1000,
      uncachedInput: 0,
    });
  });
});

describe("simulatePricing", () => {
  it("不传 cacheRate 时等价旧口径（实际 token 分布）", () => {
    const result = simulatePricing({
      totalInput: 1_000_000,
      cacheRead: 400_000,
      cacheWrite: 100_000,
      outputTokens: 200_000,
      pricing,
    });

    // 600k * 3 + 400k * 0.3 + 100k * 3.75 + 200k * 15，除以 1e6
    expect(result.cost).toBeCloseTo(1.8 + 0.12 + 0.375 + 3, 10);
    expect(result.actualCacheRate).toBeCloseTo(0.4, 10);
    expect(result.simulatedCacheRate).toBeCloseTo(0.4, 10);
    expect(result.uncachedInputTokens).toBeCloseTo(600_000, 6);
    expect(result.cacheReadTokens).toBeCloseTo(400_000, 6);
  });

  it("cacheRate=1 时全部输入按 cache read 计价", () => {
    const result = simulatePricing({
      totalInput: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      outputTokens: 0,
      pricing,
      cacheRate: 1,
    });

    expect(result.cost).toBeCloseTo(0.3, 10);
    expect(result.simulatedCacheRate).toBe(1);
  });

  it("cacheRate=0 时全部输入按 input 计价", () => {
    const result = simulatePricing({
      totalInput: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 0,
      outputTokens: 0,
      pricing,
      cacheRate: 0,
    });

    expect(result.cost).toBeCloseTo(3, 10);
    expect(result.actualCacheRate).toBe(1);
    expect(result.simulatedCacheRate).toBe(0);
  });

  it("cacheWrite / output 不受 cache rate 影响", () => {
    const base = {
      totalInput: 0,
      cacheRead: 0,
      cacheWrite: 1_000_000,
      outputTokens: 1_000_000,
      pricing,
    };
    const zero = simulatePricing({ ...base, cacheRate: 0 });
    const full = simulatePricing({ ...base, cacheRate: 1 });
    expect(zero.cost).toBeCloseTo(3.75 + 15, 10);
    expect(full.cost).toBeCloseTo(3.75 + 15, 10);
  });

  it("pricing 为 null 时成本为 0", () => {
    const result = simulatePricing({
      totalInput: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      outputTokens: 0,
      pricing: null,
    });
    expect(result.cost).toBe(0);
  });

  it("价格含 NaN / 负数时按 0 计，不污染成本", () => {
    const result = simulatePricing({
      totalInput: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      outputTokens: 0,
      pricing: { ...pricing, inputPrice: Number.NaN },
    });
    expect(result.cost).toBe(0);

    const negative = simulatePricing({
      totalInput: 1_000_000,
      cacheRead: 0,
      cacheWrite: 0,
      outputTokens: 0,
      pricing: { ...pricing, inputPrice: -5 },
    });
    expect(negative.cost).toBe(0);
  });

  it("token 负数 / NaN 兜底为 0", () => {
    const result = simulatePricing({
      totalInput: -100,
      cacheRead: Number.NaN,
      cacheWrite: -1,
      outputTokens: Number.NaN,
      pricing,
    });
    expect(result.cost).toBe(0);
    expect(result.actualCacheRate).toBe(0);
  });
});

describe("parseCacheRateInput", () => {
  it("百分比字符串转 0..1", () => {
    expect(parseCacheRateInput("12.5")).toBeCloseTo(0.125, 10);
    expect(parseCacheRateInput(" 0 ")).toBe(0);
  });

  it("上限钳到 100%", () => {
    expect(parseCacheRateInput("150")).toBe(1);
  });

  it("空串 / 非法 / 负数返回 null（跟随实际）", () => {
    expect(parseCacheRateInput("")).toBeNull();
    expect(parseCacheRateInput("   ")).toBeNull();
    expect(parseCacheRateInput("abc")).toBeNull();
    expect(parseCacheRateInput("-1")).toBeNull();
  });
});

describe("parsePriceInput", () => {
  it("合法单价解析", () => {
    expect(parsePriceInput("3.5")).toBe(3.5);
    expect(parsePriceInput("0")).toBe(0);
  });

  it("空串 / 非法 / 负数返回 null（回退官方价）", () => {
    expect(parsePriceInput("")).toBeNull();
    expect(parsePriceInput("x")).toBeNull();
    expect(parsePriceInput("-3")).toBeNull();
  });
});
