import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  buildProbeRequest,
  buildProbeHeaders,
  probeModel,
  probeModelWithKeys,
  PROBE_TIMEOUT_MS,
  PROBE_USER_AGENT,
  PROBE_KEY_NAME,
} from "./probe";
import type { HeaderTransform } from "./header-transforms";

function ht(partial: Partial<HeaderTransform> & { header: string }): HeaderTransform {
  return { id: "ht-1", value: "v", mode: "fill", enabled: true, ...partial };
}

describe("buildProbeRequest", () => {
  it("builds openai chat completions request", () => {
    const { url, body } = buildProbeRequest("openai", "https://api.example", "gpt-4o");
    expect(url).toBe("https://api.example/v1/chat/completions");
    expect(body).toEqual({
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false,
    });
  });

  it("builds openai responses request when apiStyle is responses", () => {
    const { url, body } = buildProbeRequest("openai", "https://api.example", "gpt-4o", "responses");
    expect(url).toBe("https://api.example/v1/responses");
    expect(body).toEqual({ model: "gpt-4o", input: "hi" });
  });

  it("dedupes /v1 prefix when baseUrl already ends with it", () => {
    const { url } = buildProbeRequest("openai", "https://api.example/v1", "gpt-4o");
    expect(url).toBe("https://api.example/v1/chat/completions");
  });

  it("builds anthropic messages request", () => {
    const { url, body } = buildProbeRequest("anthropic", "https://api.anthropic.com", "claude-3-5-sonnet");
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect(body).toEqual({
      model: "claude-3-5-sonnet",
      messages: [{ role: "user", content: "hi" }],
      max_tokens: 1,
      stream: false,
    });
  });

  it("builds gemini generateContent request with model in path", () => {
    const { url, body } = buildProbeRequest("gemini", "https://generativelanguage.googleapis.com/v1beta", "gemini-1.5-flash");
    expect(url).toBe(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent"
    );
    expect(body).toEqual({
      contents: [{ parts: [{ text: "hi" }] }],
      generationConfig: { maxOutputTokens: 1 },
    });
  });
});

describe("probeModel", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("sends application/json content-type with auth headers", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await probeModel({ protocol: "openai", baseUrl: "https://api.example" }, "gpt-4o", "sk-test");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer sk-test");
  });

  it("injects dispatcher when target has proxyUrl", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await probeModel(
      { protocol: "openai", baseUrl: "https://api.example", proxyUrl: "http://user:pass@proxy.example:3128" },
      "gpt-4o",
      "sk-test"
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeDefined();
  });

  it("omits dispatcher key when target has no proxyUrl", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await probeModel({ protocol: "openai", baseUrl: "https://api.example" }, "gpt-4o", "sk-test");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect("dispatcher" in init).toBe(false);
  });

  it("returns ok for 2xx", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await probeModel(
      { protocol: "openai", baseUrl: "https://api.example" },
      "gpt-4o",
      "sk-test"
    );
    expect(result).toEqual({ ok: true, status: 200, style: "chat" });
  });

  it("returns error with body snippet for non-2xx", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response('{"error":{"message":"model not found"}}', { status: 404 }))
    );
    const result = await probeModel(
      { protocol: "openai", baseUrl: "https://api.example" },
      "gpt-4o",
      "sk-test"
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.error).toContain("model not found");
  });

  it("uses redirect: manual and does not follow 3xx (credential leak guard)", async () => {
    fetchMock.mockResolvedValue(
      new Response("redirecting", {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      })
    );
    const result = await probeModel(
      { protocol: "openai", baseUrl: "https://api.example" },
      "gpt-4o",
      "sk-test"
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(302);
    expect(result.error).toContain("redirect");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init as RequestInit & { redirect?: string }).redirect).toBe("manual");
  });

  it("returns failure on network error", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await probeModel(
      { protocol: "openai", baseUrl: "https://api.example" },
      "gpt-4o",
      "sk-test"
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain("ECONNREFUSED");
  });

  it("falls back to responses probe when chat returns 404 and responses succeeds", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("model not found", { status: 404 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await probeModel(
      { protocol: "openai", baseUrl: "https://api.example" },
      "gpt-4o",
      "sk-test"
    );
    expect(result).toEqual({ ok: true, status: 200, style: "responses" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const urls = fetchMock.mock.calls.map((c) => c[0]);
    expect(urls[0]).toContain("/v1/chat/completions");
    expect(urls[1]).toContain("/v1/responses");
  });

  it("falls back to responses probe when chat returns 403", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await probeModel(
      { protocol: "openai", baseUrl: "https://api.example" },
      "gpt-4o",
      "sk-test"
    );
    expect(result).toEqual({ ok: true, status: 200, style: "responses" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to responses probe when chat returns 400", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("bad request", { status: 400 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await probeModel(
      { protocol: "openai", baseUrl: "https://api.example" },
      "gpt-4o",
      "sk-test"
    );
    expect(result).toEqual({ ok: true, status: 200, style: "responses" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to responses probe when chat returns 501 (not implemented)", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("not implemented", { status: 501 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await probeModel(
      { protocol: "openai", baseUrl: "https://api.example" },
      "gpt-4o",
      "sk-test"
    );
    expect(result).toEqual({ ok: true, status: 200, style: "responses" });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back on 401 (key-level error)", async () => {
    fetchMock.mockResolvedValue(new Response("unauthorized", { status: 401 }));
    const result = await probeModel(
      { protocol: "openai", baseUrl: "https://api.example" },
      "gpt-4o",
      "sk-test"
    );
    expect(result).toEqual({
      ok: false,
      status: 401,
      error: "unauthorized",
      style: "chat",
      contentType: "text/plain;charset=UTF-8",
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns responses result when both styles fail", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("nope", { status: 404 })));
    const result = await probeModel(
      { protocol: "openai", baseUrl: "https://api.example" },
      "gpt-4o",
      "sk-test"
    );
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.style).toBe("responses");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not fall back for anthropic", async () => {
    fetchMock.mockImplementation(() => Promise.resolve(new Response("nope", { status: 404 })));
    const result = await probeModel(
      { protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
      "claude-3-5-sonnet",
      "sk-ant"
    );
    expect(result.ok).toBe(false);
    expect(result.style).toBe("chat");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("uses anthropic auth headers and version", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await probeModel(
      { protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
      "claude-3-5-sonnet",
      "sk-ant"
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("x-api-key")).toBe("sk-ant");
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
    expect(headers.get("content-type")).toBe("application/json");
  });

  it("uses x-goog-api-key for gemini", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    await probeModel(
      { protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
      "gemini-1.5-flash",
      "gk-1"
    );
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(url).toContain(":generateContent");
    expect(headers.get("x-goog-api-key")).toBe("gk-1");
  });

  it("default timeout is 15s", () => {
    expect(PROBE_TIMEOUT_MS).toBe(15_000);
  });
});

describe("buildProbeHeaders", () => {
  const target = { protocol: "openai" as const, baseUrl: "https://api.example" };

  it("sends a client-like baseline instead of undici's `node` UA", () => {
    const headers = buildProbeHeaders(target, "sk-test", "gpt-4o");
    expect(headers.get("user-agent")).toBe(PROBE_USER_AGENT);
    expect(headers.get("user-agent")).not.toBe("node");
    expect(headers.get("accept")).toBe("application/json");
    expect(headers.get("accept-encoding")).toBe("identity");
    expect(headers.get("content-type")).toBe("application/json");
    expect(headers.get("authorization")).toBe("Bearer sk-test");
  });

  it("keeps baseline headers untouched when no transform is configured", () => {
    const headers = buildProbeHeaders(target, "sk-test", "gpt-4o");
    expect(Array.from(headers.keys()).sort()).toEqual([
      "accept",
      "accept-encoding",
      "authorization",
      "content-type",
      "user-agent",
    ]);
  });

  it("applies override transforms on top of the baseline", () => {
    const headers = buildProbeHeaders(
      { ...target, headerTransforms: [ht({ header: "User-Agent", value: "claude-cli/2.0.1", mode: "override" })] },
      "sk-test",
      "gpt-4o"
    );
    expect(headers.get("user-agent")).toBe("claude-cli/2.0.1");
  });

  it("fill mode fills only headers missing from the baseline", () => {
    const headers = buildProbeHeaders(
      {
        ...target,
        headerTransforms: [
          ht({ id: "ht-1", header: "accept", value: "text/event-stream", mode: "fill" }),
          ht({ id: "ht-2", header: "x-tenant", value: "team-a", mode: "fill" }),
        ],
      },
      "sk-test",
      "gpt-4o"
    );
    expect(headers.get("accept")).toBe("application/json"); // 基线已有 → fill 跳过
    expect(headers.get("x-tenant")).toBe("team-a");
  });

  it("skips disabled transforms", () => {
    const headers = buildProbeHeaders(
      {
        ...target,
        headerTransforms: [ht({ header: "user-agent", value: "disabled-ua", mode: "override", enabled: false })],
      },
      "sk-test",
      "gpt-4o"
    );
    expect(headers.get("user-agent")).toBe(PROBE_USER_AGENT);
  });

  it("expands template variables with probe-time values", () => {
    const headers = buildProbeHeaders(
      {
        ...target,
        upstreamName: "my-upstream",
        headerTransforms: [
          ht({
            header: "x-probe",
            value: "${var.sessionId}|${var.model}|${var.upstream}|${var.keyName}|${var.unknown}",
            mode: "override",
          }),
        ],
      },
      "sk-test",
      "gpt-4o"
    );
    const value = headers.get("x-probe") ?? "";
    const [sessionId, model, upstream, keyName, unknown] = value.split("|");
    expect(sessionId).toMatch(/^probe-[0-9a-f]{8}$/); // 临时值，非真实会话指纹
    expect(model).toBe("gpt-4o");
    expect(upstream).toBe("my-upstream");
    expect(keyName).toBe(PROBE_KEY_NAME);
    expect(unknown).toBe("${var.unknown}"); // 未知变量保留字面量
  });

  it("uses one stable sessionId per probe and a fresh one across probes", () => {
    const withSid = {
      ...target,
      headerTransforms: [
        ht({ id: "ht-1", header: "x-sid-a", value: "${var.sessionId}", mode: "override" }),
        ht({ id: "ht-2", header: "x-sid-b", value: "prefix-${var.sessionId}", mode: "override" }),
      ],
    };
    const first = buildProbeHeaders(withSid, "sk-test", "gpt-4o");
    const a = first.get("x-sid-a") ?? "";
    expect(a).toMatch(/^probe-[0-9a-f]{8}$/);
    // 同一次探测内恒定：与真实链路「同一请求内 sessionId 不变」语义对齐
    expect(first.get("x-sid-b")).toBe(`prefix-${a}`);
    // 跨探测重新生成
    expect(buildProbeHeaders(withSid, "sk-test", "gpt-4o").get("x-sid-a")).not.toBe(a);
  });

  it("applies transforms after auth injection (transform can override auth header)", () => {
    const headers = buildProbeHeaders(
      {
        ...target,
        headerTransforms: [ht({ header: "authorization", value: "Bearer override", mode: "override" })],
      },
      "sk-test",
      "gpt-4o"
    );
    expect(headers.get("authorization")).toBe("Bearer override");
  });

  it("keeps protocol-specific auth headers for anthropic/gemini", () => {
    const anthropic = buildProbeHeaders(
      { protocol: "anthropic", baseUrl: "https://api.anthropic.com" },
      "sk-ant",
      "claude-3-5-sonnet"
    );
    expect(anthropic.get("x-api-key")).toBe("sk-ant");
    expect(anthropic.get("anthropic-version")).toBe("2023-06-01");
    const gemini = buildProbeHeaders(
      { protocol: "gemini", baseUrl: "https://generativelanguage.googleapis.com/v1beta" },
      "gk-1",
      "gemini-1.5-flash"
    );
    expect(gemini.get("x-goog-api-key")).toBe("gk-1");
  });

  it("reaches the wire through probeModel", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    try {
      await probeModel(
        {
          ...target,
          upstreamName: "up-1",
          headerTransforms: [ht({ header: "user-agent", value: "agent-ua/1.0", mode: "override" })],
        },
        "gpt-4o",
        "sk-test"
      );
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const headers = new Headers(init.headers);
      expect(headers.get("user-agent")).toBe("agent-ua/1.0");
      expect(headers.get("authorization")).toBe("Bearer sk-test");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("probeModelWithKeys", () => {
  const fetchMock = vi.fn();
  const target = { protocol: "openai" as const, baseUrl: "https://api.example" };

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("succeeds on first key without testing the rest", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await probeModelWithKeys(target, "gpt-4o", ["k1", "k2", "k3"]);
    expect(result.ok).toBe(true);
    expect(result.keyResults.length).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("tries next key when first fails and succeeds on second", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const result = await probeModelWithKeys(target, "gpt-4o", ["bad", "good"]);
    expect(result.ok).toBe(true);
    expect(result.keyResults).toEqual([
      { ok: false, status: 401, error: "unauthorized" },
      { ok: true, status: 200 },
    ]);
    expect(result.sawAuthError).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails with sawModelError when all keys return 404", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response("model not found", { status: 404 }))
    );
    const result = await probeModelWithKeys(target, "gpt-4o", ["k1", "k2"]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    expect(result.sawModelError).toBe(true);
    expect(result.sawAuthError).toBe(false);
    expect(result.keyResults.length).toBe(2);
  });

  it("fails with sawAuthError when all keys return 401", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(new Response("unauthorized", { status: 401 }))
    );
    const result = await probeModelWithKeys(target, "gpt-4o", ["k1", "k2"]);
    expect(result.ok).toBe(false);
    expect(result.sawAuthError).toBe(true);
    expect(result.sawModelError).toBe(false);
  });

  it("reports last status and error on network failure", async () => {
    fetchMock.mockRejectedValue(new Error("ECONNREFUSED"));
    const result = await probeModelWithKeys(target, "gpt-4o", ["k1"]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain("ECONNREFUSED");
    expect(result.sawModelError).toBe(false);
    expect(result.sawAuthError).toBe(false);
  });

  it("does not treat 403 HTML (edge/bot block) as model error", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response("<!doctype html><title>Attention Required</title>", {
          status: 403,
          headers: { "content-type": "text/html" },
        })
      )
    );
    const result = await probeModelWithKeys(target, "gpt-4o", ["k1", "k2"]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.sawModelError).toBe(false);
    expect(result.sawAuthError).toBe(false);
    expect(result.keyResults.length).toBe(2);
  });

  it("treats 403 JSON as model error", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        new Response(JSON.stringify({ error: { message: "model not allowed" } }), {
          status: 403,
          headers: { "content-type": "application/json" },
        })
      )
    );
    const result = await probeModelWithKeys(target, "gpt-4o", ["k1"]);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(403);
    expect(result.sawModelError).toBe(true);
  });
});
