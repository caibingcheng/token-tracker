import { describe, expect, it } from "vitest";
import { simulateRoute, type SimUpstream, type SimManualRule } from "./simulate-route";

function upstream(partial: Partial<SimUpstream> & { id: number }): SimUpstream {
  return {
    id: partial.id,
    name: partial.name ?? `upstream-${partial.id}`,
    protocol: partial.protocol ?? "openai",
    priority: partial.priority ?? 0,
    enabled: partial.enabled ?? true,
    enabledModels: partial.enabledModels ?? [],
    unhealthy: partial.unhealthy ?? false,
    modelUnhealthy: partial.modelUnhealthy ?? [],
  };
}

function rule(partial: Partial<SimManualRule> & { id: number; upstreamId: number }): SimManualRule {
  return {
    id: partial.id,
    name: partial.name ?? "my-alias",
    protocol: partial.protocol ?? "openai",
    upstreamId: partial.upstreamId,
    targetModel: partial.targetModel ?? "real-model",
    priority: partial.priority ?? 0,
  };
}

describe("simulateRoute", () => {
  it("manual route short-circuits automatic routing", () => {
    const upstreams = [
      upstream({ id: 1, enabledModels: ["my-alias"] }),
      upstream({ id: 2, enabledModels: ["gpt-4o"] }),
    ];
    const rules = [rule({ id: 1, upstreamId: 2, name: "my-alias", targetModel: "gpt-4o" })];
    const result = simulateRoute("my-alias", "openai", upstreams, rules);
    expect(result.source).toBe("manual");
    expect(result.winner?.upstreamId).toBe(2);
    expect(result.winner?.matchedPattern).toBe("gpt-4o");
    expect(result.winner?.matchType).toBe("exact");
    expect(result.manualRouteUnavailable).toBe(false);
  });

  it("manual route hits even when automatic routing has no candidate", () => {
    const upstreams = [upstream({ id: 1, enabledModels: ["gpt-4o"] })];
    const rules = [rule({ id: 1, upstreamId: 1, name: "fake-alias", targetModel: "gpt-4o" })];
    const result = simulateRoute("fake-alias", "openai", upstreams, rules);
    expect(result.source).toBe("manual");
    expect(result.winner?.upstreamId).toBe(1);
  });

  it("manual failover chain ordered by priority then id", () => {
    const upstreams = [upstream({ id: 1 }), upstream({ id: 2 }), upstream({ id: 3 })];
    const rules = [
      rule({ id: 3, upstreamId: 2, priority: 2 }),
      rule({ id: 2, upstreamId: 1, priority: 1 }),
      rule({ id: 1, upstreamId: 3, priority: 1 }),
    ];
    const result = simulateRoute("my-alias", "openai", upstreams, rules);
    expect(result.candidates.map((c) => c.upstreamId)).toEqual([3, 1, 2]);
  });

  it("skips targets whose upstream is disabled", () => {
    const upstreams = [upstream({ id: 1 }), upstream({ id: 2, enabled: false })];
    const rules = [
      rule({ id: 1, upstreamId: 2, name: "a1", priority: 0 }),
      rule({ id: 2, upstreamId: 1, name: "a1", priority: 1 }),
    ];
    const result = simulateRoute("a1", "openai", upstreams, rules);
    expect(result.winner?.upstreamId).toBe(1);
    expect(result.skipped).toEqual([
      { upstreamId: 2, targetModel: "real-model", reason: "disabled" },
    ]);
    expect(result.manualRouteUnavailable).toBe(false);
  });

  it("skips targets whose upstream does not exist", () => {
    const upstreams = [upstream({ id: 1 })];
    const rules = [rule({ id: 1, upstreamId: 99, name: "a2" })];
    const result = simulateRoute("a2", "openai", upstreams, rules);
    expect(result.skipped).toEqual([
      { upstreamId: 99, targetModel: "real-model", reason: "missing" },
    ]);
    expect(result.manualRouteUnavailable).toBe(true);
    expect(result.winner).toBeNull();
  });

  it("reports manual_route_unavailable when all targets are invalid", () => {
    const upstreams = [upstream({ id: 1, enabled: false })];
    const rules = [
      rule({ id: 1, upstreamId: 1, name: "a3", priority: 0 }),
      rule({ id: 2, upstreamId: 42, name: "a3", priority: 1 }),
    ];
    const result = simulateRoute("a3", "openai", upstreams, rules);
    expect(result.manualRouteUnavailable).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.effective.winner).toBeNull();
  });

  it("model-level health is checked against targetModel, not virtual name", () => {
    const upstreams = [
      upstream({ id: 1, modelUnhealthy: ["virtual-name"] }),
      upstream({ id: 2, modelUnhealthy: ["other-model"] }),
    ];
    const rules = [
      rule({ id: 1, upstreamId: 1, name: "virtual-name", targetModel: "real-model", priority: 0 }),
      rule({ id: 2, upstreamId: 2, name: "virtual-name", targetModel: "other-model", priority: 1 }),
    ];
    const result = simulateRoute("virtual-name", "openai", upstreams, rules);
    expect(result.candidates.find((c) => c.upstreamId === 1)?.modelUnavailable).toBe(false);
    expect(result.candidates.find((c) => c.upstreamId === 2)?.modelUnavailable).toBe(true);
  });

  it("manual chain reorders healthy targets first (failover)", () => {
    const upstreams = [upstream({ id: 1, unhealthy: true }), upstream({ id: 2 })];
    const rules = [
      rule({ id: 1, upstreamId: 1, name: "a4", priority: 0 }),
      rule({ id: 2, upstreamId: 2, name: "a4", priority: 1 }),
    ];
    const result = simulateRoute("a4", "openai", upstreams, rules);
    expect(result.effective.winner?.upstreamId).toBe(2);
    expect(result.effective.failover).toBe(true);
    expect(result.effective.allUnhealthy).toBe(false);
  });

  it("manual chain reports last resort when all targets unhealthy", () => {
    const upstreams = [upstream({ id: 1, unhealthy: true }), upstream({ id: 2, unhealthy: true })];
    const rules = [
      rule({ id: 1, upstreamId: 1, name: "a5", priority: 0 }),
      rule({ id: 2, upstreamId: 2, name: "a5", priority: 1 }),
    ];
    const result = simulateRoute("a5", "openai", upstreams, rules);
    expect(result.effective.winner?.upstreamId).toBe(1);
    expect(result.effective.allUnhealthy).toBe(true);
    expect(result.effective.failover).toBe(false);
  });

  it("falls back to automatic routing when no manual rule matches", () => {
    const upstreams = [
      upstream({ id: 1, enabledModels: ["gpt-4o"] }),
      upstream({ id: 2, enabledModels: ["gpt-4o"], priority: 5 }),
    ];
    const result = simulateRoute("gpt-4o", "openai", upstreams, []);
    expect(result.source).toBe("auto");
    expect(result.winner?.upstreamId).toBe(1);
    expect(result.winner?.matchType).toBe("exact");
  });

  it("automatic routing attaches upstream health flags", () => {
    const upstreams = [
      upstream({ id: 1, enabledModels: ["gpt-4o"], unhealthy: true }),
      upstream({ id: 2, enabledModels: ["gpt-4o"], priority: 5 }),
    ];
    const result = simulateRoute("gpt-4o", "openai", upstreams, []);
    expect(result.winner?.upstreamUnhealthy).toBe(true);
    expect(result.effective.winner?.upstreamId).toBe(2);
    expect(result.effective.failover).toBe(true);
  });

  it("automatic routing ignores disabled upstreams", () => {
    const upstreams = [
      upstream({ id: 1, enabledModels: ["gpt-4o"], enabled: false }),
      upstream({ id: 2, enabledModels: ["gpt-4o"], priority: 5 }),
    ];
    const result = simulateRoute("gpt-4o", "openai", upstreams, []);
    expect(result.winner?.upstreamId).toBe(2);
  });

  it("respects protocol in manual matching", () => {
    const upstreams = [upstream({ id: 1, protocol: "anthropic" })];
    const rules = [rule({ id: 1, upstreamId: 1, name: "my-alias", protocol: "anthropic" })];
    const result = simulateRoute("my-alias", "openai", upstreams, rules);
    expect(result.source).toBe("auto");
  });
});
