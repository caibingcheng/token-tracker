import { describe, it, expect } from "vitest";
import { aggregateAgents } from "./agent-stats";

function makeRow(
  overrides: {
    userAgent?: string | null;
    totalInput?: number;
    totalInputCached?: number;
    totalOutput?: number;
    count?: number;
  } = {}
) {
  return {
    group: "2026-11-01",
    userAgent: "userAgent" in overrides ? overrides.userAgent : "opencode/1.18.14",
    totalInput: overrides.totalInput ?? 100,
    totalInputCached: overrides.totalInputCached ?? 0,
    totalInputUncached: 0,
    totalOutput: overrides.totalOutput ?? 0,
    totalCacheWrite: 0,
    count: overrides.count ?? 1,
  };
}

describe("aggregateAgents", () => {
  it("按派生 agent 名合并 token 与 count", () => {
    const result = aggregateAgents([
      makeRow({ userAgent: "claude-cli/2.1.5 (external, cli)", totalInput: 100, count: 2 }),
      makeRow({ userAgent: "claude-cli/2.1.5 (external, cli)", totalInput: 50, count: 1 }),
      makeRow({ userAgent: "opencode/1.18.14", totalInput: 400, count: 3 }),
    ]);
    expect(result).toHaveLength(2);
    const claude = result.find((r) => r.agent === "claude-code")!;
    expect(claude.totalInput).toBe(150);
    expect(claude.count).toBe(3);
    expect(result.find((r) => r.agent === "opencode")!.totalInput).toBe(400);
  });

  it("null / 空 UA 归为 unknown", () => {
    const result = aggregateAgents([
      makeRow({ userAgent: null, totalInput: 10 }),
      makeRow({ userAgent: "", totalInput: 10 }),
      makeRow({ userAgent: "   ", totalInput: 10 }),
    ]);
    expect(result).toEqual([
      { agent: "unknown", totalInput: 30, totalInputCached: 0, totalOutput: 0, count: 3 },
    ]);
  });

  it("手动 agent aliases 把多个 UA token 映射到同一 name", () => {
    const result = aggregateAgents(
      [
        makeRow({ userAgent: "my-cli/1.0", totalInput: 10 }),
        makeRow({ userAgent: "My-CLI/2.0", totalInput: 20 }),
      ],
      [{ name: "my-agent", aliases: ["my-cli"] }]
    );
    expect(result).toHaveLength(1);
    expect(result[0]!.agent).toBe("my-agent");
    expect(result[0]!.totalInput).toBe(30);
  });

  it("按 totalInput 降序", () => {
    const result = aggregateAgents([
      makeRow({ userAgent: "a/1", totalInput: 10 }),
      makeRow({ userAgent: "b/1", totalInput: 50 }),
      makeRow({ userAgent: "c/1", totalInput: 30 }),
    ]);
    expect(result.map((r) => r.agent)).toEqual(["b", "c", "a"]);
  });

  it("空输入返回空数组", () => {
    expect(aggregateAgents([])).toEqual([]);
  });
});
