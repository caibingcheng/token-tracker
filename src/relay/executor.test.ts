// relay 执行器测试：plan 的 continueOn / passthrough / lease / 私网双条件 / 流式 usage / report 内容。
// 上游出站用 setOutboundFetchImpl 注入；report 走 vi.mock（不真发请求）。
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./plan-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./plan-client")>();
  return { ...actual, sendReport: vi.fn() };
});

import { executePlan } from "./executor";
import { sendReport } from "./plan-client";
import type { PlanWire } from "./plan-client";
import { generateDeviceKeypair, sealLease } from "@/lib/gateway/lease";
import { setOutboundFetchImpl } from "@/lib/gateway/outbound-fetch";
import type { PreparedRequest } from "./prepare";

const sendReportMock = sendReport as unknown as ReturnType<typeof vi.fn>;

const keypair = generateDeviceKeypair();

function preparedOf(over: Partial<PreparedRequest> = {}): PreparedRequest {
  const bodyBuffer = new TextEncoder().encode(
    JSON.stringify({ model: "my-route", messages: [{ role: "user", content: "hi" }] })
  );
  return {
    method: "POST",
    path: "/v1/chat/completions",
    protocol: "openai",
    model: "my-route",
    stream: false,
    nativeSessionId: null,
    sessionInput: "hi",
    hasMessages: true,
    estimatedInputTokens: 10,
    vkFp: "f".repeat(64),
    headerNames: ["authorization"],
    bodyBuffer,
    bodyScan: null,
    bodyJson: JSON.parse(new TextDecoder().decode(bodyBuffer)),
    ...over,
  };
}

function planOf(hops: PlanWire["hops"], over: Partial<PlanWire> = {}): PlanWire {
  return {
    planId: "plan-test",
    expiresAt: Date.now() + 600_000,
    quota: { reservedTokens: 10, reservedRpm: 1 },
    hops,
    modelsSnapshot: null,
    policy: {
      streamIdleTimeoutMinutes: 30,
      centerMaxBodyMb: 32,
      centerMaxResponseBufferMb: 50,
    },
    ...over,
  };
}

function hopOf(over: Partial<PlanWire["hops"][number]> = {}): PlanWire["hops"][number] {
  const base = {
    hopIndex: 0,
    upstreamId: 1,
    keyId: 11,
    keyLease: "",
    leaseExpiresAt: Date.now() + 60_000,
    realModel: "gpt-a",
    retries: 2,
    continueOn: ["401", "403", "404", "429", "5xx", "network", "timeout"],
    stopOn: ["2xx"],
    passthrough: "last-4xx" as const,
    timeoutMs: 60_000,
    suppressHealth: [] as string[],
    skipSiblingsOn: ["403", "404"] as string[],
  };
  const merged = { ...base, ...over };
  merged.keyLease = sealLease(
    {
      v: 1,
      planId: "plan-test",
      upstreamId: merged.upstreamId,
      keyId: merged.keyId,
      apiKey: `sk-${merged.upstreamId}-${merged.keyId}`,
      protocol: "openai",
      url: `https://u${merged.upstreamId}.example.com/v1/chat/completions`,
      proxyUrl: null,
      headers: {},
      requiresPrivateNetwork: false,
      expiresAt: merged.leaseExpiresAt,
    },
    keypair.publicKey
  );
  return merged;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const request = () => new Request("http://relay.local/v1/chat/completions", { method: "POST" });

function call(plan: PlanWire, prepared = preparedOf(), req = request()) {
  return executePlan({
    plan,
    deviceToken: "dt-test",
    devicePrivateKeyPem: keypair.privateKeyPem,
    prepared,
    request: req,
  });
}

beforeEach(() => {
  sendReportMock.mockClear();
});

afterEach(() => {
  setOutboundFetchImpl(null);
});

describe("executePlan", () => {
  it("404 按 continueOn 换下一 hop；成功 hop 透传 + model 回写 + usage 写进 report", async () => {
    const urls: string[] = [];
    setOutboundFetchImpl(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("u1.")) return jsonResponse(404, { error: { message: "no model" } });
      return jsonResponse(200, {
        model: "gpt-a",
        choices: [{ message: { role: "assistant", content: "hi" } }],
        usage: { prompt_tokens: 11, completion_tokens: 7, prompt_tokens_details: { cached_tokens: 3 } },
      });
    });

    const res = await call(planOf([hopOf(), hopOf({ hopIndex: 1, upstreamId: 2, keyId: 21 })]));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    // 命名路由 hop：响应 model 回写虚拟名（请求名）
    expect(body.model).toBe("my-route");
    expect(urls).toHaveLength(2);

    expect(sendReportMock).toHaveBeenCalledTimes(1);
    const report = sendReportMock.mock.calls[0]![1] as any;
    expect(report.status).toBe("ok");
    expect(report.winner).toEqual({ hopIndex: 1, upstreamId: 2, keyId: 21 });
    // input_tokens 不含 cache_read（与直连写库口径一致：11 prompt - 3 cached = 8）
    expect(report.usage).toMatchObject({ inputTokens: 8, outputTokens: 7, cacheRead: 3, hasUsage: true });
    expect(report.failures).toEqual([
      { hopIndex: 0, upstreamId: 1, keyId: 11, status: 404, bodyKind: "json", cause: "http" },
    ]);
  });

  it("retries 是每个 key 的总尝试次数（5xx 同 key 重试两次再换 hop）", async () => {
    const urls: string[] = [];
    setOutboundFetchImpl(async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.includes("u1.")) return jsonResponse(502, { error: { message: "boom" } });
      return jsonResponse(200, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    const res = await call(planOf([hopOf(), hopOf({ hopIndex: 1, upstreamId: 2, keyId: 21 })]));
    expect(res.status).toBe(200);
    expect(urls.filter((u) => u.includes("u1."))).toHaveLength(2);
    const report = sendReportMock.mock.calls[0]![1] as any;
    expect(report.failures.filter((f: any) => f.upstreamId === 1)).toHaveLength(2);
  });

  it("3xx 一律视为失败，不跟随、不保留", async () => {
    let calls = 0;
    setOutboundFetchImpl(async () => {
      calls++;
      return new Response(null, { status: 302, headers: { location: "https://evil.example" } });
    });
    const res = await call(planOf([hopOf({ retries: 1 })]));
    expect(res.status).toBe(502);
    expect(calls).toBe(1);
    const report = sendReportMock.mock.calls[0]![1] as any;
    expect(report.status).toBe("failed");
    expect(report.failures[0]).toMatchObject({ status: 302, cause: "http" });
  });

  it("requiresPrivateNetwork + 本端未开 ALLOW_PRIVATE_UPSTREAMS → 跳过该 hop（不发请求）", async () => {
    let calls = 0;
    setOutboundFetchImpl(async () => {
      calls++;
      return jsonResponse(200, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    const hop = hopOf();
    hop.keyLease = sealLease(
      {
        v: 1,
        planId: "plan-test",
        upstreamId: 1,
        keyId: 11,
        apiKey: "sk",
        protocol: "openai",
        url: "http://127.0.0.1:8080/v1/chat/completions",
        proxyUrl: null,
        headers: {},
        requiresPrivateNetwork: true,
        expiresAt: Date.now() + 60_000,
      },
      keypair.publicKey
    );
    const res = await call(planOf([hop]));
    expect(res.status).toBe(502);
    expect(calls).toBe(0);
    // 本端策略失败不算上游失败：不产生 failures（不污染中心健康判定）
    const report = sendReportMock.mock.calls[0]![1] as any;
    expect(report.failures).toEqual([]);
  });

  it("stopOn 的 4xx-other：直接透传该响应并终止全链（不继续试其他 upstream）", async () => {
    let calls = 0;
    setOutboundFetchImpl(async () => {
      calls++;
      return jsonResponse(400, { error: { message: "bad param", type: "invalid_request_error" } });
    });
    const res = await call(
      planOf([hopOf({ retries: 1 }), hopOf({ hopIndex: 1, upstreamId: 2, keyId: 21 })])
    );
    expect(res.status).toBe(400);
    expect(calls).toBe(1);
    const report = sendReportMock.mock.calls[0]![1] as any;
    // 与直连同口径：业务 4xx 也记一条零 token 的 no_usage（winner = 该 hop）
    expect(report.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cacheRead: 0,
      cacheWrite: 0,
      hasUsage: false,
    });
    expect(report.winner).toEqual({ hopIndex: 0, upstreamId: 1, keyId: 11 });
  });

  it("skipSiblingsOn：403/404 跳过同 upstream 剩余 key（换 upstream），401 只换 key", async () => {
    const attempted: number[] = [];
    setOutboundFetchImpl(async () => {
      // u1 的两把 key 都是 hopIndex 0/1；用 url 区分不了 key，改用调用顺序记录
      const status = 404;
      attempted.push(status);
      return jsonResponse(status, { error: { message: "no" } });
    });
    const hops = [
      hopOf({ hopIndex: 0, upstreamId: 1, keyId: 11, retries: 1 }),
      hopOf({ hopIndex: 1, upstreamId: 1, keyId: 12, retries: 1 }),
      hopOf({ hopIndex: 2, upstreamId: 2, keyId: 21, retries: 1 }),
    ];
    const res = await call(planOf(hops));
    // u1 首个 key 404 → 跳到 u2；u1 的第二把 key 不该被尝试 → 总共 2 次请求
    expect(attempted).toHaveLength(2);
    // 全链耗尽：透传最后一个业务 404
    expect(res.status).toBe(404);
    const report = sendReportMock.mock.calls[0]![1] as any;
    expect(report.failures.map((f: any) => f.keyId)).toEqual([11, 21]);

    // 401 不跳过兄弟 key：两把 key 都试
    attempted.length = 0;
    sendReportMock.mockClear();
    setOutboundFetchImpl(async () => {
      attempted.push(401);
      return jsonResponse(401, { error: { message: "bad key" } });
    });
    await call(planOf(hops));
    expect(attempted).toHaveLength(3);
  });

  it("流式：边透传边累计 usage，report 带 ttftMs 与 hasUsage", async () => {
    const sse =
      'data: {"id":"resp_1","choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"usage":{"prompt_tokens":5,"completion_tokens":2}}\n\n' +
      "data: [DONE]\n\n";
    setOutboundFetchImpl(
      async () =>
        new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } })
    );
    const res = await call(planOf([hopOf({ realModel: "my-route" })]), preparedOf({ stream: true }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toContain("[DONE]");
    // 流读完 onDone 才发 report
    await new Promise((r) => setTimeout(r, 10));
    const report = sendReportMock.mock.calls[0]![1] as any;
    expect(report.status).toBe("ok");
    expect(report.usage).toMatchObject({ inputTokens: 5, outputTokens: 2, hasUsage: true });
    expect(typeof report.ttftMs).toBe("number");
  });

  it("弱匹配：hop 缺 continueOn/retries/skipSiblingsOn → 兜底默认可用", async () => {
    // 兜底 continueOn 含 429 → 同 key 重试一次后成功，全链可用
    let calls = 0;
    setOutboundFetchImpl(async () => {
      calls++;
      if (calls === 1) return jsonResponse(429, { error: { message: "slow" } });
      return jsonResponse(200, { choices: [], usage: { prompt_tokens: 1, completion_tokens: 1 } });
    });
    const base = hopOf();
    const minimalHop = {
      hopIndex: 0,
      upstreamId: 1,
      keyId: 11,
      keyLease: base.keyLease,
      leaseExpiresAt: base.leaseExpiresAt,
      realModel: "gpt-a",
    } as PlanWire["hops"][number];
    const plan = planOf([minimalHop]);
    const res = await call(plan);
    expect(res.status).toBe(200);
    expect(calls).toBe(2);
    const report = sendReportMock.mock.calls[0]![1] as any;
    expect(report.winner).toEqual({ hopIndex: 0, upstreamId: 1, keyId: 11 });
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ status: 429 });
  });

  it("continueOn 不含 network：网络失败终止全链，不试后续 hop", async () => {
    const urls: string[] = [];
    setOutboundFetchImpl(async (input: unknown) => {
      urls.push(String(input));
      throw new Error("ECONNREFUSED");
    });
    const res = await call(
      planOf([hopOf({ continueOn: ["401", "429"] }), hopOf({ hopIndex: 1, upstreamId: 2, keyId: 21 })])
    );
    expect(res.status).toBe(502);
    expect(urls).toHaveLength(1);
    const report = sendReportMock.mock.calls[0]![1] as any;
    expect(report.status).toBe("failed");
    expect(report.failures).toHaveLength(1);
    expect(report.failures[0]).toMatchObject({ cause: "network", status: null });
    // 无 retained、无 winner：不写零 token 记录（usage 为 null）
    expect(report.winner).toBeNull();
    expect(report.usage).toBeNull();
    expect(sendReportMock).toHaveBeenCalledTimes(1);
  });

  it("non-streaming 响应超 centerMaxResponseBufferMb：report stream_interrupted + 502，上限可由 plan 下发调小", async () => {
    let calls = 0;
    setOutboundFetchImpl(async () => {
      calls++;
      const big = new Uint8Array(2 * 1024 * 1024);
      return new Response(big, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": String(big.length) },
      });
    });
    const plan = planOf([hopOf()]);
    plan.policy.centerMaxResponseBufferMb = 1; // plan 下发 1MB（默认是 50）
    const res = await call(plan);
    expect(res.status).toBe(502);
    expect(calls).toBe(1);
    // 上游已真实产生输出：必须发 report，否则预留空等到期清扫、usage 丢失
    const report = sendReportMock.mock.calls[0]![1] as any;
    expect(report.status).toBe("stream_interrupted");
    expect(report.winner).toEqual({ hopIndex: 0, upstreamId: 1, keyId: 11 });
    expect(sendReportMock).toHaveBeenCalledTimes(1);
  });

  // 截断口径：mock 带**显式** content-length + 超过 256KB 的 body（构造的 Response 不会自动补
  // content-length，不带显式值时断言是空守卫）。bufferRetained 读到 256KB 截断，透传时
  // content-length 必须被剥掉，否则长度/实际字节不符。
  it("全链耗尽透传保留响应时剥掉 content-length（body 已按 256KB 截断）", async () => {
    const padding = Buffer.alloc(300 * 1024, "x");
    setOutboundFetchImpl(async () =>
      new Response(JSON.stringify({ error: { message: "no" } }) + padding.toString(), {
        status: 404,
        headers: {
          "content-type": "application/json",
          "content-length": String(300 * 1024 + 23),
        },
      })
    );
    const res = await call(planOf([hopOf({ retries: 1 })]));
    expect(res.status).toBe(404);
    expect(res.headers.get("content-length")).toBeNull();
    expect(res.headers.get("content-type")).toContain("json");
    // 确认真的截断了（透传的是 256KB 而不是完整 body）
    expect((await res.text()).length).toBeLessThan(300 * 1024);
  });

  it("4xx-other 提前透传路径同样剥 content-length", async () => {
    setOutboundFetchImpl(async () =>
      new Response(JSON.stringify({ error: { message: "bad param" } }), {
        status: 400,
        headers: { "content-type": "application/json", "content-length": "33" },
      })
    );
    const res = await call(planOf([hopOf({ retries: 1 })]));
    expect(res.status).toBe(400);
    expect(res.headers.get("content-length")).toBeNull();
    expect(sendReportMock).toHaveBeenCalledTimes(1);
  });

  it("先前 hop 保留的 404 + 后续 hop 网络失败（continueOn 不含 network）→ break hopLoop 走尾部透传", async () => {
    setOutboundFetchImpl(async (input: unknown) => {
      if (String(input).includes("u1.")) return jsonResponse(404, { error: { message: "no" } });
      throw new Error("ECONNREFUSED");
    });
    const res = await call(
      planOf([
        hopOf({ hopIndex: 0, upstreamId: 1, keyId: 11, retries: 1 }),
        hopOf({ hopIndex: 1, upstreamId: 2, keyId: 21, retries: 1, continueOn: ["401", "429"] }),
      ])
    );
    // 终链但不是全新失败：尾部透传 hop0 保留的业务 404 + 零 token 记录（winner = retainedBy）
    expect(res.status).toBe(404);
    expect(res.headers.get("content-length")).toBeNull();
    expect(sendReportMock).toHaveBeenCalledTimes(1);
    const report = sendReportMock.mock.calls[0]![1] as any;
    expect(report.winner).toEqual({ hopIndex: 0, upstreamId: 1, keyId: 11 });
    expect(report.usage).toMatchObject({ hasUsage: false });
    expect(report.failures).toHaveLength(2);
    expect(report.failures?.[1]).toMatchObject({ upstreamId: 2, cause: "network" });
  });

  it("旧中心不下发 centerMaxResponseBufferMb（undefined）→ 兑退 50MB 常量", async () => {
    setOutboundFetchImpl(async () => {
      const big = new Uint8Array(2 * 1024 * 1024); // 2MB < 50MB：正常透传
      return new Response(big, { status: 200, headers: { "content-type": "application/json" } });
    });
    const plan: PlanWire = planOf([hopOf()]);
    delete (plan.policy as { centerMaxResponseBufferMb?: number }).centerMaxResponseBufferMb;
    const res = await call(plan);
    expect(res.status).toBe(200);
    const report = sendReportMock.mock.calls[0]![1] as any;
    expect(report.status).toBe("ok");
  });
});
