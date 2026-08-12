import { describe, it, expect } from "vitest";
import {
  percentile,
  aggregateLatencyByModel,
  aggregateLatencyDaily,
  type LatencyRow,
} from "@/lib/latency-query";

function row(partial: Partial<LatencyRow> & { model: string }): LatencyRow {
  return {
    provider: "openai",
    ttftMs: null,
    latencyMs: null,
    outputTokens: 0,
    createdAt: "2026-08-10T10:00:00.000Z",
    ...partial,
  };
}

describe("percentile", () => {
  it("returns null for empty input", () => {
    expect(percentile([], 0.5)).toBeNull();
  });

  it("returns the middle value for odd length", () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
  });

  it("interpolates linearly for even length", () => {
    // index = (4-1)*0.5 = 1.5 → avg of 2 and 3
    expect(percentile([1, 2, 3, 4], 0.5)).toBe(2.5);
  });

  it("handles p=0 and p=1", () => {
    expect(percentile([10, 20, 30], 0)).toBe(10);
    expect(percentile([10, 20, 30], 1)).toBe(30);
  });
});

describe("aggregateLatencyByModel", () => {
  const active = new Set(["gpt-4o", "deepseek-chat"]);

  it("groups by normalized model x provider and computes p50/avg", () => {
    const rows: LatencyRow[] = [
      row({ model: "gpt-4o", provider: "openai", ttftMs: 100, latencyMs: 500, outputTokens: 50 }),
      row({ model: "gpt-4o", provider: "openai", ttftMs: 300, latencyMs: 900, outputTokens: 150 }),
      row({ model: "gpt-4o", provider: "azure", ttftMs: 1000, latencyMs: 2000, outputTokens: 100 }),
      row({ model: "gpt-4o", provider: "azure", ttftMs: 800, latencyMs: 1600, outputTokens: 100 }),
    ];
    const result = aggregateLatencyByModel(rows, active);

    expect(result).toHaveLength(2);
    const openai = result.find((r) => r.provider === "openai")!;
    expect(openai.model).toBe("gpt-4o");
    expect(openai.count).toBe(2);
    expect(openai.streamCount).toBe(2);
    expect(openai.p50TtftMs).toBe(200); // (100+300)/2
    expect(openai.avgTtftMs).toBe(200);
    expect(openai.avgLatencyMs).toBe(700);
    // tok/s = (50+150) / ((400+600)/1000) = 200 / 1 = 200
    expect(openai.outputTokensPerSec).toBe(200);
  });

  it("filters out models not in the active set", () => {
    const rows: LatencyRow[] = [
      row({ model: "gpt-4o", ttftMs: 100, latencyMs: 500 }),
      row({ model: "retired-model", ttftMs: 100, latencyMs: 500 }),
    ];
    const result = aggregateLatencyByModel(rows, active);
    expect(result).toHaveLength(1);
    expect(result[0].model).toBe("gpt-4o");
  });

  it("excludes non-stream rows from TTFT stats but keeps them in avg latency and count", () => {
    const rows: LatencyRow[] = [
      row({ model: "gpt-4o", ttftMs: 100, latencyMs: 400 }),
      row({ model: "gpt-4o", ttftMs: null, latencyMs: 200 }),
    ];
    const result = aggregateLatencyByModel(rows, active);
    const stat = result[0];
    expect(stat.count).toBe(2);
    expect(stat.streamCount).toBe(1);
    expect(stat.p50TtftMs).toBe(100);
    expect(stat.avgLatencyMs).toBe(300);
  });

  it("excludes rows where latency <= ttft from tok/s but not from TTFT stats", () => {
    const rows: LatencyRow[] = [
      row({ model: "gpt-4o", ttftMs: 100, latencyMs: 300, outputTokens: 200 }),
      row({ model: "gpt-4o", ttftMs: 500, latencyMs: 300, outputTokens: 999 }),
    ];
    const result = aggregateLatencyByModel(rows, active);
    const stat = result[0];
    expect(stat.streamCount).toBe(2);
    expect(stat.p50TtftMs).toBe(300);
    // 只算第一条：200 / (0.2s) = 1000
    expect(stat.outputTokensPerSec).toBe(1000);
  });

  it("returns null latency fields when no stream samples", () => {
    const rows: LatencyRow[] = [
      row({ model: "gpt-4o", ttftMs: null, latencyMs: 200 }),
    ];
    const result = aggregateLatencyByModel(rows, active);
    expect(result[0].p50TtftMs).toBeNull();
    expect(result[0].avgTtftMs).toBeNull();
    expect(result[0].avgLatencyMs).toBe(200);
    expect(result[0].outputTokensPerSec).toBeNull();
  });

  it("sorts fastest first with null-p50 rows last", () => {
    const rows: LatencyRow[] = [
      row({ model: "deepseek-chat", provider: "deepseek", ttftMs: 900, latencyMs: 1200 }),
      row({ model: "gpt-4o", provider: "azure", ttftMs: 200, latencyMs: 500 }),
      row({ model: "gpt-4o", provider: "openai", ttftMs: null, latencyMs: 300 }),
    ];
    const result = aggregateLatencyByModel(rows, active);
    expect(result.map((r) => r.provider)).toEqual(["azure", "deepseek", "openai"]);
  });

  it("handles empty input", () => {
    expect(aggregateLatencyByModel([], active)).toEqual([]);
  });
});

describe("aggregateLatencyDaily", () => {
  it("groups by local date with tz offset", () => {
    const rows: LatencyRow[] = [
      // 2026-08-10 23:00 UTC = 2026-08-11 07:00 UTC+8（offset=-480）
      row({ model: "gpt-4o", ttftMs: 100, createdAt: "2026-08-10T23:00:00.000Z" }),
      row({ model: "gpt-4o", ttftMs: 300, createdAt: "2026-08-10T23:00:00.000Z" }),
      // 2026-08-11 01:00 UTC = 2026-08-11 09:00 UTC+8
      row({ model: "gpt-4o", ttftMs: 200, createdAt: "2026-08-11T01:00:00.000Z" }),
    ];
    // UTC+8
    const tz8 = aggregateLatencyDaily(rows, -480);
    expect(tz8).toEqual([
      { group: "2026-08-11", streamCount: 3, avgTtftMs: 200, p50TtftMs: 200 },
    ]);

    // UTC-7（offset=+420）：3 行全部落在 08-10
    const tzNeg7 = aggregateLatencyDaily(rows, 420);
    expect(tzNeg7).toEqual([
      { group: "2026-08-10", streamCount: 3, avgTtftMs: 200, p50TtftMs: 200 },
    ]);
  });

  it("skips non-stream rows", () => {
    const rows: LatencyRow[] = [
      row({ model: "gpt-4o", ttftMs: null, createdAt: "2026-08-10T10:00:00.000Z" }),
    ];
    expect(aggregateLatencyDaily(rows, 0)).toEqual([]);
  });
});
