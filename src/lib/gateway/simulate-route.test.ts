import { describe, expect, it } from "vitest";
import { simulateRoute, type SimUpstream, type SimNamedRoute } from "./simulate-route";

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

// 命名路由：默认双目标 + 规则分类器（无 LLM）
function named(partial: Partial<SimNamedRoute> & { name?: string } = {}): SimNamedRoute {
  return {
    name: partial.name ?? "auto",
    protocol: partial.protocol ?? "openai",
    enabled: partial.enabled ?? true,
    classifierUpstreamName: partial.classifierUpstreamName ?? "typesafe",
    classifierModel: partial.classifierModel ?? "jev-latest",
    classifierKind: partial.classifierKind ?? "priority",
    targets: partial.targets ?? [
      { id: 1, upstreamId: 1, targetModel: "gpt-4o-mini", priority: 0 },
      { id: 2, upstreamId: 2, targetModel: "gpt-5", priority: 1 },
    ],
  };
}

describe("simulateRoute", () => {
  it("named route short-circuits automatic routing", () => {
    const upstreams = [
      upstream({ id: 1, enabledModels: ["my-alias"] }),
      upstream({ id: 2, enabledModels: ["gpt-4o"] }),
    ];
    const routes = [named({ name: "my-alias", targets: [{ id: 1, upstreamId: 2, targetModel: "gpt-4o", priority: 0 }] })];
    const result = simulateRoute("my-alias", "openai", upstreams, routes);
    expect(result.source).toBe("named");
    expect(result.winner?.upstreamId).toBe(2);
    expect(result.winner?.matchedPattern).toBe("gpt-4o");
    expect(result.winner?.matchType).toBe("exact");
    expect(result.namedRouteUnavailable).toBe(false);
  });

  it("named route hits even when automatic routing has no candidate", () => {
    const upstreams = [upstream({ id: 1, enabledModels: ["gpt-4o"] })];
    const routes = [named({ name: "fake-alias", targets: [{ id: 1, upstreamId: 1, targetModel: "gpt-4o", priority: 0 }] })];
    const result = simulateRoute("fake-alias", "openai", upstreams, routes);
    expect(result.source).toBe("named");
    expect(result.winner?.upstreamId).toBe(1);
  });

  it("failover chain ordered by priority then id", () => {
    const upstreams = [upstream({ id: 1 }), upstream({ id: 2 }), upstream({ id: 3 })];
    const routes = [
      named({
        targets: [
          { id: 3, upstreamId: 2, targetModel: "real-model", priority: 2 },
          { id: 2, upstreamId: 1, targetModel: "real-model", priority: 1 },
          { id: 1, upstreamId: 3, targetModel: "real-model", priority: 1 },
        ],
      }),
    ];
    const result = simulateRoute("auto", "openai", upstreams, routes);
    expect(result.candidates.map((c) => c.upstreamId)).toEqual([3, 1, 2]);
  });

  it("skips targets whose upstream is disabled", () => {
    const upstreams = [upstream({ id: 1 }), upstream({ id: 2, enabled: false })];
    const routes = [
      named({
        targets: [
          { id: 1, upstreamId: 2, targetModel: "real-model", priority: 0 },
          { id: 2, upstreamId: 1, targetModel: "real-model", priority: 1 },
        ],
      }),
    ];
    const result = simulateRoute("auto", "openai", upstreams, routes);
    expect(result.winner?.upstreamId).toBe(1);
    expect(result.skipped).toEqual([{ upstreamId: 2, targetModel: "real-model", reason: "disabled" }]);
    expect(result.namedRouteUnavailable).toBe(false);
  });

  it("skips targets whose upstream does not exist", () => {
    const upstreams = [upstream({ id: 1 })];
    const routes = [named({ name: "a2", targets: [{ id: 1, upstreamId: 99, targetModel: "real-model", priority: 0 }] })];
    const result = simulateRoute("a2", "openai", upstreams, routes);
    expect(result.skipped).toEqual([{ upstreamId: 99, targetModel: "real-model", reason: "missing" }]);
    expect(result.namedRouteUnavailable).toBe(true);
    expect(result.winner).toBeNull();
  });

  it("reports named_route_unavailable when all targets are invalid", () => {
    const upstreams = [upstream({ id: 1, enabled: false })];
    const routes = [
      named({
        name: "a3",
        targets: [
          { id: 1, upstreamId: 1, targetModel: "real-model", priority: 0 },
          { id: 2, upstreamId: 42, targetModel: "real-model", priority: 1 },
        ],
      }),
    ];
    const result = simulateRoute("a3", "openai", upstreams, routes);
    expect(result.namedRouteUnavailable).toBe(true);
    expect(result.candidates).toEqual([]);
    expect(result.effective.winner).toBeNull();
  });

  it("model-level health is checked against the target model, not the virtual name", () => {
    const upstreams = [
      upstream({ id: 1, modelUnhealthy: ["virtual-name"] }),
      upstream({ id: 2, modelUnhealthy: ["other-model"] }),
    ];
    const routes = [
      named({
        name: "virtual-name",
        targets: [
          { id: 1, upstreamId: 1, targetModel: "real-model", priority: 0 },
          { id: 2, upstreamId: 2, targetModel: "other-model", priority: 1 },
        ],
      }),
    ];
    const result = simulateRoute("virtual-name", "openai", upstreams, routes);
    expect(result.candidates.find((c) => c.upstreamId === 1)?.modelUnavailable).toBe(false);
    expect(result.candidates.find((c) => c.upstreamId === 2)?.modelUnavailable).toBe(true);
  });

  it("chain reorders healthy targets first (failover)", () => {
    const upstreams = [upstream({ id: 1, unhealthy: true }), upstream({ id: 2 })];
    const routes = [
      named({
        name: "a4",
        targets: [
          { id: 1, upstreamId: 1, targetModel: "real-model", priority: 0 },
          { id: 2, upstreamId: 2, targetModel: "real-model", priority: 1 },
        ],
      }),
    ];
    const result = simulateRoute("a4", "openai", upstreams, routes);
    expect(result.effective.winner?.upstreamId).toBe(2);
    expect(result.effective.failover).toBe(true);
    expect(result.effective.allUnhealthy).toBe(false);
  });

  it("chain reports last resort when all targets unhealthy", () => {
    const upstreams = [upstream({ id: 1, unhealthy: true }), upstream({ id: 2, unhealthy: true })];
    const routes = [
      named({
        name: "a5",
        targets: [
          { id: 1, upstreamId: 1, targetModel: "real-model", priority: 0 },
          { id: 2, upstreamId: 2, targetModel: "real-model", priority: 1 },
        ],
      }),
    ];
    const result = simulateRoute("a5", "openai", upstreams, routes);
    expect(result.effective.winner?.upstreamId).toBe(1);
    expect(result.effective.allUnhealthy).toBe(true);
    expect(result.effective.failover).toBe(false);
  });

  it("falls back to automatic routing when no named route matches", () => {
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

  it("respects protocol in named route matching", () => {
    const upstreams = [upstream({ id: 1, protocol: "anthropic" })];
    const routes = [named({ name: "my-alias", protocol: "anthropic" })];
    const result = simulateRoute("my-alias", "openai", upstreams, routes);
    expect(result.source).toBe("auto");
  });

  it("named route shadows automatic routing for the same name", () => {
    const upstreams = [upstream({ id: 1 }), upstream({ id: 2 }), upstream({ id: 3, enabledModels: ["auto"] })];
    const result = simulateRoute("auto", "openai", upstreams, [named({ classifierKind: "model" })]);
    expect(result.source).toBe("named");
    expect(result.candidates.every((c) => c.upstreamId !== 3)).toBe(true);
  });

  it("LLM classifier with multiple targets: no deterministic winner, priority-min shown first", () => {
    const upstreams = [upstream({ id: 1 }), upstream({ id: 2 })];
    const result = simulateRoute("auto", "openai", upstreams, [named({ classifierKind: "model" })]);
    expect(result.source).toBe("named");
    expect(result.classifier).toEqual({
      classifierUpstreamName: "typesafe",
      classifierModel: "jev-latest",
      kind: "model",
    });
    expect(result.candidates.map((c) => c.matchedPattern)).toEqual(["gpt-4o-mini", "gpt-5"]);
    expect(result.winner).toBeNull();
    expect(result.effective.winner).toBeNull();
    expect(result.namedRouteUnavailable).toBe(false);
  });

  it("derives a deterministic winner for the rule classifier (first healthy target)", () => {
    const upstreams = [upstream({ id: 1, unhealthy: true }), upstream({ id: 2 })];
    const result = simulateRoute("auto", "openai", upstreams, [named({ classifierKind: "priority" })]);
    expect(result.source).toBe("named");
    expect(result.classifier?.kind).toBe("priority");
    // 确定性 winner：首个健康目标（跳过 unhealthy 的 priority 最小者）
    expect(result.effective.winner?.upstreamId).toBe(2);
    expect(result.effective.winner?.matchedPattern).toBe("gpt-5");
    expect(result.effective.failover).toBe(true);
  });

  it("single-target named route skips the classifier (deterministic winner)", () => {
    const upstreams = [upstream({ id: 1 })];
    const routes = [named({ classifierKind: "model", targets: [{ id: 1, upstreamId: 1, targetModel: "gpt-4o-mini", priority: 0 }] })];
    const result = simulateRoute("auto", "openai", upstreams, routes);
    expect(result.classifier?.kind).toBe("model");
    expect(result.winner?.upstreamId).toBe(1);
    expect(result.effective.winner?.upstreamId).toBe(1);
  });

  it("disabled named route falls back to automatic routing", () => {
    const upstreams = [upstream({ id: 1, enabledModels: ["auto"] })];
    const result = simulateRoute("auto", "openai", upstreams, [named({ enabled: false })]);
    expect(result.source).toBe("auto");
  });

  it("named route targets on disabled/missing upstreams are skipped", () => {
    const upstreams = [upstream({ id: 1, enabled: false }), upstream({ id: 2 })];
    const result = simulateRoute("auto", "openai", upstreams, [named()]);
    expect(result.source).toBe("named");
    expect(result.candidates.map((c) => c.matchedPattern)).toEqual(["gpt-5"]);
    expect(result.skipped).toEqual([{ upstreamId: 1, targetModel: "gpt-4o-mini", reason: "disabled" }]);
  });
});
