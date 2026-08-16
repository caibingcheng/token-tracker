import { describe, it, expect } from "vitest";
import { aggregateProviders } from "@/lib/provider-stats";
import { emptyAggregatedCost, type AggregatedCost } from "@/lib/cost-utils";
import type { HiddenProviderGroup } from "@/lib/provider-utils";

interface RowInput {
  group: string;
  model: string;
  provider?: string;
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalOutput: number;
  totalCacheWrite: number;
  count: number;
  cost?: AggregatedCost;
}

function makeRow(overrides: Partial<RowInput> & { provider?: string }): RowInput {
  return {
    group: "2026-08-01",
    model: "gpt-4o",
    totalInput: 1000,
    totalInputCached: 200,
    totalInputUncached: 800,
    totalOutput: 500,
    totalCacheWrite: 0,
    count: 2,
    ...overrides,
  };
}

function makeCost(totalCost: number): AggregatedCost {
  return { ...emptyAggregatedCost(), totalCost };
}

const HIDDEN_GROUPS: HiddenProviderGroup[] = [
  { name: "Provider A", letter: "A", patterns: ["openai"] },
];

describe("aggregateProviders", () => {
  it("按 provider 合并 token 与 count", () => {
    const rows = [
      makeRow({
        provider: "openai",
        group: "2026-08-01",
        totalInput: 100,
        totalInputCached: 30,
        totalOutput: 50,
        count: 3,
      }),
      makeRow({
        provider: "openai",
        group: "2026-08-02",
        totalInput: 200,
        totalInputCached: 60,
        totalOutput: 70,
        count: 4,
      }),
      makeRow({
        provider: "anthropic",
        group: "2026-08-01",
        totalInput: 400,
        totalInputCached: 100,
        totalOutput: 90,
        count: 5,
      }),
    ];
    const result = aggregateProviders(rows, []);
    expect(result).toHaveLength(2);

    const openai = result.find((r) => r.provider === "openai")!;
    expect(openai.totalInput).toBe(300);
    expect(openai.totalInputCached).toBe(90);
    expect(openai.totalOutput).toBe(120);
    expect(openai.count).toBe(7);
    expect(openai.providerName).toBe("openai");

    const anthropic = result.find((r) => r.provider === "anthropic")!;
    expect(anthropic.totalInput).toBe(400);
    expect(anthropic.count).toBe(5);
  });

  it("cost 经 mergeAggregatedCosts 合并", () => {
    const rows = [
      makeRow({ provider: "openai", cost: makeCost(1.5) }),
      makeRow({ provider: "openai", cost: makeCost(2.5) }),
    ];
    const result = aggregateProviders(rows, []);
    expect(result).toHaveLength(1);
    expect(result[0].totalCost).toBe(4);
  });

  it("无 cost 行 totalCost = 0", () => {
    const result = aggregateProviders([makeRow({ provider: "openai" })], []);
    expect(result).toHaveLength(1);
    expect(result[0].totalCost).toBe(0);
  });

  it("遵守 hidden_providers 匿名化", () => {
    const rows = [
      makeRow({ provider: "openai" }),
      makeRow({ provider: "anthropic" }),
    ];
    const result = aggregateProviders(rows, HIDDEN_GROUPS);
    expect(result.find((r) => r.provider === "openai")!.providerName).toBe(
      "Provider A"
    );
    expect(result.find((r) => r.provider === "anthropic")!.providerName).toBe(
      "anthropic"
    );
  });

  it("不截断：超过 5 个 provider 全部返回", () => {
    const rows = ["p1", "p2", "p3", "p4", "p5", "p6"].map((provider, i) =>
      makeRow({ provider, totalInput: 100 - i })
    );
    const result = aggregateProviders(rows, []);
    expect(result).toHaveLength(6);
  });

  it("按 totalInput 降序", () => {
    const rows = [
      makeRow({ provider: "a", totalInput: 10 }),
      makeRow({ provider: "b", totalInput: 50 }),
      makeRow({ provider: "c", totalInput: 30 }),
    ];
    const result = aggregateProviders(rows, []);
    expect(result.map((r) => r.provider)).toEqual(["b", "c", "a"]);
  });

  it("provider 缺失回退 unknown", () => {
    const result = aggregateProviders([makeRow({ provider: undefined })], []);
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("unknown");
    expect(result[0].providerName).toBe("unknown");
  });

  it("空输入返回空数组", () => {
    expect(aggregateProviders([], [])).toEqual([]);
  });
});
