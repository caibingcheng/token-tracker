// report → 健康标记的纯逻辑测试（分 mode，对齐 proxy.ts）
import { describe, it, expect } from "vitest";
import { planHealthActions, type ReportFailure, type ReportHop } from "./report";

const hops: ReportHop[] = [
  { hopIndex: 0, upstreamId: 1, keyId: 11, realModel: "gpt-a" },
  { hopIndex: 1, upstreamId: 1, keyId: 12, realModel: "gpt-a" },
  { hopIndex: 2, upstreamId: 2, keyId: 21, realModel: "gpt-b" },
];

const failure = (over: Partial<ReportFailure>): ReportFailure => ({
  hopIndex: 0,
  upstreamId: 1,
  keyId: 11,
  status: 500,
  bodyKind: "json",
  cause: "http",
  ...over,
});

describe("planHealthActions", () => {
  it("router：404 / 403(json) → model 级标记；403(html) 与 429/5xx 不标记", () => {
    expect(
      planHealthActions({
        mode: "router",
        hops,
        failures: [failure({ status: 404 })],
        winner: null,
      })
    ).toEqual([{ type: "markModelUnhealthy", upstreamId: 1, model: "gpt-a" }]);

    expect(
      planHealthActions({
        mode: "router",
        hops,
        failures: [failure({ status: 403, bodyKind: "json" })],
        winner: null,
      })
    ).toEqual([{ type: "markModelUnhealthy", upstreamId: 1, model: "gpt-a" }]);

    for (const f of [
      failure({ status: 403, bodyKind: "html" }),
      failure({ status: 429 }),
      failure({ status: 503 }),
    ]) {
      expect(
        planHealthActions({ mode: "router", hops, failures: [f], winner: null })
      ).toEqual([]);
    }
  });

  it("router：401/网络错误 → 同 upstream 全 key 覆盖才 markUnhealthy", () => {
    expect(
      planHealthActions({
        mode: "router",
        hops,
        failures: [failure({ status: 401 })],
        winner: null,
      })
    ).toEqual([]);
    expect(
      planHealthActions({
        mode: "router",
        hops,
        failures: [
          failure({ status: 401 }),
          failure({ hopIndex: 1, keyId: 12, status: 401 }),
        ],
        winner: null,
      })
    ).toEqual([{ type: "markUnhealthy", upstreamId: 1 }]);
    expect(
      planHealthActions({
        mode: "router",
        hops,
        failures: [
          failure({ status: null, cause: "network", bodyKind: null }),
          failure({ hopIndex: 1, keyId: 12, status: null, cause: "timeout", bodyKind: null }),
        ],
        winner: null,
      })
    ).toEqual([{ type: "markUnhealthy", upstreamId: 1 }]);
  });

  it("responses-create：403/404 不打 model 级标记（可能是不支持 responses API）", () => {
    for (const status of [403, 404]) {
      expect(
        planHealthActions({
          mode: "responses-create",
          hops,
          failures: [failure({ status })],
          winner: null,
        })
      ).toEqual([]);
    }
  });

  it("responses-subresource：404/403 零健康标记；401 全 key 才 markUnhealthy", () => {
    for (const status of [403, 404]) {
      expect(
        planHealthActions({
          mode: "responses-subresource",
          hops,
          failures: [failure({ status })],
          winner: null,
        })
      ).toEqual([]);
    }
    expect(
      planHealthActions({
        mode: "responses-subresource",
        hops,
        failures: [failure({ status: 401 }), failure({ hopIndex: 1, keyId: 12, status: 401 })],
        winner: null,
      })
    ).toEqual([{ type: "markUnhealthy", upstreamId: 1 }]);
  });

  it("winner → markHealthy + markModelHealthy（realModel 为 null 时只标 upstream）", () => {
    expect(
      planHealthActions({
        mode: "router",
        hops,
        failures: [],
        winner: { hopIndex: 2, upstreamId: 2, keyId: 21 },
      })
    ).toEqual([
      { type: "markHealthy", upstreamId: 2 },
      { type: "markModelHealthy", upstreamId: 2, model: "gpt-b" },
    ]);
    expect(
      planHealthActions({
        mode: "responses-subresource",
        hops: [{ hopIndex: 0, upstreamId: 3, keyId: 31, realModel: null }],
        failures: [],
        winner: { hopIndex: 0, upstreamId: 3, keyId: 31 },
      })
    ).toEqual([{ type: "markHealthy", upstreamId: 3 }]);
  });

  it("hopIndex 与中心副本对不上（伪造 report）→ 整条丢弃", () => {
    expect(
      planHealthActions({
        mode: "router",
        hops,
        failures: [failure({ hopIndex: 9, upstreamId: 1, keyId: 11, status: 404 })],
        winner: { hopIndex: 9, upstreamId: 1, keyId: 11 },
      })
    ).toEqual([]);
  });
});
