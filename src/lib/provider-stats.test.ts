import { describe, it, expect } from "vitest";
import { aggregateProviders, type ProviderStat } from "@/lib/provider-stats";
import { emptyAggregatedCost, type AggregatedCost } from "@/lib/cost-utils";
import type { HiddenProviderGroup } from "@/lib/provider-utils";
import type { StatItem } from "@/lib/model-utils";

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

function makeRow(
  overrides: Partial<RowInput> & { provider?: string }
): StatItem & { group: string; model: string; provider?: string } {
  return {
    group: "2026-08-01",
    model: "gpt-4o",
    totalInput: 1000,
    totalOutput: 500,
    totalInputCached: 200,
    totalInputUncached: 800,
    totalCacheWrite: 0,
    count: 2,
    ...overrides,
  };
}

function makeCost(totalCost: number): AggregatedCost {
  return { ...emptyAggregatedCost(), totalCost };
}

function byProvider(result: ProviderStat[], name: string) {
  return result.find((r) => r.provider === name);
}

describe("provider group merge", () => {
  it("merges same-group providers into a single row", () => {
    const groups: HiddenProviderGroup[] = [
      { name: "opencode", letter: "A", patterns: ["opencode-direct", "opencode-proxy"] },
    ];
    const rows = [
      makeRow({
        provider: "opencode-direct",
        totalInput: 100,
        totalInputCached: 30,
        totalOutput: 50,
        count: 3,
        cost: makeCost(1.5),
      }),
      makeRow({
        provider: "opencode-proxy",
        totalInput: 200,
        totalInputCached: 60,
        totalOutput: 70,
        count: 4,
        cost: makeCost(2.5),
      }),
      makeRow({
        provider: "anthropic",
        totalInput: 400,
        totalInputCached: 100,
        totalOutput: 90,
        count: 5,
      }),
    ];

    const result = aggregateProviders(rows, groups);

    expect(result).toHaveLength(2);

    const opencode = byProvider(result, "opencode")!;
    expect(opencode.providerName).toBe("opencode");
    expect(opencode.totalInput).toBe(300);
    expect(opencode.totalInputCached).toBe(90);
    expect(opencode.totalOutput).toBe(120);
    expect(opencode.count).toBe(7);
    expect(opencode.totalCost).toBe(4);

    const anthropic = byProvider(result, "anthropic")!;
    expect(anthropic.totalInput).toBe(400);
    expect(anthropic.providerName).toBe("anthropic");
  });

  it("keeps ungrouped providers as-is", () => {
    const groups: HiddenProviderGroup[] = [
      { name: "opencode", letter: "A", patterns: ["opencode-direct", "opencode-proxy"] },
    ];
    const rows = [
      makeRow({ provider: "openai", totalInput: 100, count: 1 }),
      makeRow({ provider: "google", totalInput: 200, count: 2 }),
    ];

    const result = aggregateProviders(rows, groups);
    expect(result).toHaveLength(2);
    expect(byProvider(result, "openai")).toBeDefined();
    expect(byProvider(result, "google")).toBeDefined();
    expect(byProvider(result, "openai")?.providerName).toBe("openai");
  });

  it("legacy format keeps each provider in its own row", () => {
    // legacy: each pattern is its own group mapped to Provider A/B...
    const groups: HiddenProviderGroup[] = [
      { name: "Provider A", letter: "A", patterns: ["openai"] },
      { name: "Provider B", letter: "B", patterns: ["anthropic"] },
    ];
    const rows = [
      makeRow({ provider: "openai", totalInput: 100, count: 1 }),
      makeRow({ provider: "anthropic", totalInput: 200, count: 2 }),
    ];

    const result = aggregateProviders(rows, groups);
    expect(result).toHaveLength(2);
    expect(byProvider(result, "Provider A")?.providerName).toBe("Provider A");
    expect(byProvider(result, "Provider B")?.providerName).toBe("Provider B");
  });

  it("merges providers matched by wildcard pattern within a group", () => {
    const groups: HiddenProviderGroup[] = [
      { name: "opencode", letter: "A", patterns: ["opencode*"] },
    ];
    const rows = [
      makeRow({ provider: "opencode-a", totalInput: 100, count: 1 }),
      makeRow({ provider: "opencode-b", totalInput: 200, count: 2 }),
      makeRow({ provider: "other", totalInput: 50, count: 1 }),
    ];

    const result = aggregateProviders(rows, groups);
    expect(result).toHaveLength(2);
    expect(byProvider(result, "opencode")?.totalInput).toBe(300);
    expect(byProvider(result, "opencode")?.count).toBe(3);
    expect(byProvider(result, "other")?.totalInput).toBe(50);
  });
});
