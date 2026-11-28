// plan 失败体解析：两种形状必须分开——业务错误 `{error:{message,type}}` vs
// device token 被拒 `{success:false,error:"..."}`（withDeviceAuth）。后者要能被识别出来
// 才能触发 relay 自愈（清 token + 重新配对），而不是永远给客户端一个 401 upstream_error。
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/gateway/outbound-fetch", () => ({ outboundFetch: vi.fn() }));
vi.mock("@/lib/gateway/proxy-dispatcher", () => ({ getOutboundDispatcher: () => null }));

import { parsePlanFailure, requestPlan, sendReport, type PlanRequest, type ReportPayload } from "./plan-client";
import { outboundFetch } from "@/lib/gateway/outbound-fetch";
import { resetRttForTest, rttSnapshot } from "./latency";

const mockedFetch = vi.mocked(outboundFetch);

const planRequest: PlanRequest = {
  vkFp: "vkfp",
  path: "/v1/chat/completions",
  model: "gpt-a",
  protocol: "openai",
  stream: false,
  nativeSessionId: null,
  sessionFingerprint: null,
  hasMessages: true,
  responseId: null,
  userAgent: "agent/1.0",
  estimatedInputTokens: 10,
  headerNames: ["authorization"],
};

const reportPayload: ReportPayload = {
  planId: "p1",
  status: "ok",
  winner: null,
  failures: [],
  usage: null,
  latencyMs: 100,
  ttftMs: null,
  responseId: null,
};

const planBody = {
  planId: "p1",
  expiresAt: Date.now() + 60_000,
  quota: { reservedTokens: 0, reservedRpm: 1 },
  hops: [],
  modelsSnapshot: null,
  policy: { streamIdleTimeoutMinutes: 5, centerMaxBodyMb: 32, centerMaxResponseBufferMb: 128 },
};

beforeEach(() => {
  resetRttForTest();
  mockedFetch.mockReset();
});

describe("RTT 上报接线", () => {
  it("plan 调用的耗时进 plan 桶，并随下一次 report 的 centerRtt 带上去", async () => {
    mockedFetch.mockResolvedValue(new Response(JSON.stringify(planBody), { status: 200 }));
    await requestPlan("dt-token", planRequest);
    expect(rttSnapshot().some((b) => b.kind === "plan")).toBe(true);

    mockedFetch.mockResolvedValue(new Response("{}", { status: 200 }));
    sendReport("dt-token", reportPayload);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const call = mockedFetch.mock.calls.at(-1);
    expect(call?.[0]).toContain("/api/device/report");
    const body = JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));
    expect(body.planId).toBe("p1");
    expect(Array.isArray(body.centerRtt)).toBe(true);
    expect(body.centerRtt.some((b: { kind: string }) => b.kind === "plan")).toBe(true);
  });
});

describe("parsePlanFailure", () => {
  it("device token 被拒（withDeviceAuth 形状）→ deviceTokenRejected", () => {
    const failure = parsePlanFailure(401, { success: false, error: "Invalid or revoked device token" });
    expect(failure.deviceTokenRejected).toBe(true);
    expect(failure.error.error.message).toBe("Invalid or revoked device token");
  });

  it("业务错误（planError 形状）→ 保留 type，不当作 token 被拒", () => {
    const failure = parsePlanFailure(401, { error: { message: "Invalid or revoked virtual key", type: "invalid_api_key" } });
    expect(failure.deviceTokenRejected).toBeUndefined();
    expect(failure.status).toBe(401);
    expect(failure.error.error).toEqual({ message: "Invalid or revoked virtual key", type: "invalid_api_key" });
  });

  it("非 401 的 success:false 不算 token 被拒（例如 400 invalid_request_error）", () => {
    const failure = parsePlanFailure(400, { success: false, error: "bad request" });
    expect(failure.deviceTokenRejected).toBeUndefined();
    expect(failure.error.error.message).toBe("bad request");
  });

  it("非 JSON / 空 body → 兜底文案与 upstream_error 类型", () => {
    const failure = parsePlanFailure(502, null);
    expect(failure.error.error).toEqual({ message: "plan failed", type: "upstream_error" });
  });

  it("reason:revoked → deviceRevoked（relay 保留 token，不重新配对）", () => {
    const revoked = parsePlanFailure(401, {
      success: false,
      error: "Invalid or revoked device token",
      reason: "revoked",
    });
    expect(revoked.deviceTokenRejected).toBe(true);
    expect(revoked.deviceRevoked).toBe(true);

    // 旧中心 / 未知 token：无 reason → 不当作 revoked，仍走自愈重配
    const invalid = parsePlanFailure(401, {
      success: false,
      error: "Invalid or revoked device token",
      reason: "invalid",
    });
    expect(invalid.deviceTokenRejected).toBe(true);
    expect(invalid.deviceRevoked).toBeUndefined();
  });
});
