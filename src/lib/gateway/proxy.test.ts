import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { handleProxyRequest, extractVirtualKeyToken, MAX_RETRY } from "./proxy";
import type { ProxyDeps } from "./proxy";
import type { UpstreamRoute } from "./model-router";
import { buildSessionId } from "./session";

function mkUpstream(overrides: Partial<UpstreamRoute>): UpstreamRoute {
  return {
    id: 1,
    name: "openai",
    protocol: "openai",
    baseUrl: "https://upstream.example",
    priority: 0,
    enabled: true,
    enabledModels: ["gpt-4o", "gpt-*"],
    ...overrides,
  };
}

function mkDeps(overrides: Partial<ProxyDeps> = {}): ProxyDeps {
  return {
    resolveVirtualKey: vi.fn(async (token: string) =>
      token === "vk-good"
        ? { id: 1, name: "claude-code", enabled: true, enabledModels: ["*"] }
        : null
    ),
    resolveUpstreamKeys: vi.fn(async () => ["key-1", "key-2"]),
    loadUpstreams: vi.fn(async () => [mkUpstream({})]),
    onUsage: vi.fn(async () => {}),
    onComplete: vi.fn(async () => {}),
    quota: {
      loadUsage: vi.fn(async () => ({ rpm: 0, tpm: 0, dailyTokens: 0, monthlyTokens: 0 })),
    },
    log: vi.fn(),
    ...overrides,
  };
}

function makeRequest(
  path: string,
  opts: {
    method?: string;
    body?: unknown;
    headers?: Record<string, string>;
  } = {}
): Request {
  const headers = new Headers({ "content-type": "application/json", ...opts.headers });
  const body = opts.body === undefined ? null : JSON.stringify(opts.body);
  return new Request(`https://gw.example${path}`, {
    method: opts.method ?? "POST",
    headers,
    body,
  });
}

describe("extractVirtualKeyToken", () => {
  it("extracts from Authorization Bearer", () => {
    const headers = new Headers({ authorization: "Bearer vk-abc" });
    expect(extractVirtualKeyToken(headers, new URLSearchParams())).toBe("vk-abc");
  });

  it("extracts from x-api-key (Anthropic style)", () => {
    const headers = new Headers({ "x-api-key": "vk-abc" });
    expect(extractVirtualKeyToken(headers, new URLSearchParams())).toBe("vk-abc");
  });

  it("extracts from x-goog-api-key (Gemini style)", () => {
    const headers = new Headers({ "x-goog-api-key": "vk-abc" });
    expect(extractVirtualKeyToken(headers, new URLSearchParams())).toBe("vk-abc");
  });

  it("extracts from query param key (Gemini style)", () => {
    const headers = new Headers();
    expect(
      extractVirtualKeyToken(headers, new URLSearchParams("key=vk-abc"))
    ).toBe("vk-abc");
  });

  it("returns null when missing", () => {
    const headers = new Headers();
    expect(extractVirtualKeyToken(headers, new URLSearchParams())).toBeNull();
  });
});

describe("handleProxyRequest - auth", () => {
  it("returns 401 when token missing", async () => {
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", { body: { model: "gpt-4o" } }),
      mkDeps()
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when token invalid", async () => {
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-bad" },
        body: { model: "gpt-4o" },
      }),
      mkDeps()
    );
    expect(res.status).toBe(401);
  });

  it("returns 401 when virtual key disabled", async () => {
    const deps = mkDeps({
      resolveVirtualKey: vi.fn(async () => ({ id: 1, name: "x", enabled: false })),
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    expect(res.status).toBe(401);
  });
});

describe("handleProxyRequest - routing errors", () => {
  it("returns 400 when model cannot be determined", async () => {
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: {},
      }),
      mkDeps()
    );
    expect(res.status).toBe(400);
  });

  it("returns 403 when model not allowed by virtual key", async () => {
    const deps = mkDeps({
      resolveVirtualKey: vi.fn(async () => ({
        id: 1,
        name: "claude-code",
        enabled: true,
        enabledModels: ["gpt-4o", "gpt-*"],
      })),
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "claude-3-5-sonnet" },
      }),
      deps
    );
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.type).toBe("model_not_allowed");
  });

  it("allows model matching virtual key wildcard pattern", async () => {
    const deps = mkDeps({
      resolveVirtualKey: vi.fn(async () => ({
        id: 1,
        name: "claude-code",
        enabled: true,
        enabledModels: ["gpt-*"],
      })),
      resolveUpstreamKeys: vi.fn(async () => ["key-1"]),
      loadUpstreams: vi.fn(async () => [mkUpstream({ enabledModels: ["gpt-4o"] })]),
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    expect(res.status).toBe(502); // 路由成功，仅因无 fetch mock 而 502
  });

  it("returns 404 when model not routed", async () => {
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "unknown-xyz" },
      }),
      mkDeps()
    );
    expect(res.status).toBe(404);
  });

  it("returns 502 when upstream has no keys", async () => {
    const deps = mkDeps({ resolveUpstreamKeys: vi.fn(async () => []) });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    expect(res.status).toBe(502);
  });
});

describe("handleProxyRequest - protocol mismatch", () => {
  it("returns 400 when request path is openai but upstream is anthropic", async () => {
    const deps = mkDeps({
      loadUpstreams: vi.fn(async () => [mkUpstream({ protocol: "anthropic", name: "anthropic-upstream" })]),
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("protocol_mismatch");
    expect(json.error.message).toContain("anthropic");
  });

  it("returns 400 when request path is anthropic but upstream is openai", async () => {
    const deps = mkDeps({
      loadUpstreams: vi.fn(async () => [mkUpstream({ protocol: "openai", name: "openai-upstream", enabledModels: ["claude-3-5-sonnet"] })]),
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/messages", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "claude-3-5-sonnet" },
      }),
      deps
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("protocol_mismatch");
  });

  it("returns 400 when request path is openai but upstream is gemini", async () => {
    const deps = mkDeps({
      loadUpstreams: vi.fn(async () => [
        mkUpstream({
          protocol: "gemini",
          name: "gemini-upstream",
          enabledModels: ["gemini-1.5-flash"],
        }),
      ]),
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gemini-1.5-flash" },
      }),
      deps
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error.type).toBe("protocol_mismatch");
  });
});

describe("handleProxyRequest - failover chain", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("retries 429 within key then moves to next key", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      mkDeps()
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3); // key-1 重试 2 次 + key-2 成功
  });

  it("passes 4xx business errors through without retry", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "bad request" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    );

    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      mkDeps()
    );
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries on network error then succeeds on next key", async () => {
    fetchMock
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockRejectedValueOnce(new Error("socket hang up"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true }), { status: 200, headers: { "content-type": "application/json" } }));

    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      mkDeps()
    );
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("returns 502 with last upstream error when all keys fail", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 503 }));

    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      mkDeps()
    );
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(MAX_RETRY * 2); // 2 keys × 2 retries
  });

  it("injects upstream auth header and strips client auth", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

    const deps = mkDeps({
      resolveUpstreamKeys: vi.fn(async () => ["secret-key-1"]),
    });
    await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: {
          authorization: "Bearer vk-good",
          "x-api-key": "vk-good",
        },
        body: { model: "gpt-4o" },
      }),
      deps
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = new Headers(init.headers);
    expect(headers.get("authorization")).toBe("Bearer secret-key-1");
    expect(headers.get("x-api-key")).toBeNull();
    expect(headers.get("accept-encoding")).toBe("identity");
  });

  it("forwards request body unchanged", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200, headers: { "content-type": "application/json" } }));

    const body = { model: "gpt-4o", messages: [{ role: "user", content: "hi" }], stream: false };
    await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body,
      }),
      mkDeps()
    );

    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const sentBody = JSON.parse(new TextDecoder().decode(init.body as Uint8Array));
    expect(sentBody).toEqual(body);
  });
});

describe("handleProxyRequest - usage capture & write-back", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("parses non-streaming usage and calls onUsage", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5, prompt_tokens_details: { cached_tokens: 3 } } }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );

    const deps = mkDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    await res.text();

    expect(deps.onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 7, outputTokens: 5, cacheRead: 3, cacheWrite: 0, agent: "claude-code", provider: "openai", model: "gpt-4o", virtualKeyId: 1 })
    );
  });

  it("records status=no_usage when response has no usage", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ text: "hi" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const deps = mkDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    await res.text();

    expect(deps.onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ status: "no_usage", inputTokens: 0, outputTokens: 0 })
    );
  });

  it("parses streaming usage from SSE and still passes stream through", async () => {
    const sse =
      'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"id":"1","choices":[],"usage":{"prompt_tokens":50,"completion_tokens":20}}\n\n' +
      "data: [DONE]\n\n";
    fetchMock.mockResolvedValueOnce(
      new Response(sse, {
        status: 200,
        headers: { "content-type": "text/event-stream" },
      })
    );

    const deps = mkDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", stream: true },
      }),
      deps
    );
    const received = await res.text();

    expect(received).toBe(sse); // 原样透传
    expect(deps.onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 50, outputTokens: 20 })
    );
  });

  it("does not record usage for 4xx business errors", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ error: { message: "invalid" } }), {
        status: 400,
        headers: { "content-type": "application/json" },
      })
    );

    const deps = mkDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    await res.text();

    expect(deps.onUsage).not.toHaveBeenCalled();
  });

  it("calls onComplete with virtual key id", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const deps = mkDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    await res.text();

    expect(deps.onComplete).toHaveBeenCalledWith({ virtualKeyId: 1 });
  });

  it("passes user-agent header through to onUsage meta", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const deps = mkDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good", "user-agent": "claude-cli/1.2.3 (x86_64)" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    await res.text();

    expect(deps.onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ userAgent: "claude-cli/1.2.3 (x86_64)" })
    );
  });

  it("sets userAgent null when header missing", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const deps = mkDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    await res.text();

    expect(deps.onUsage).toHaveBeenCalledWith(expect.objectContaining({ userAgent: null }));
  });

  it("truncates user-agent to 512 chars", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const longUA = "x".repeat(700);
    const deps = mkDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good", "user-agent": longUA },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    await res.text();

    expect(deps.onUsage).toHaveBeenCalledWith(expect.objectContaining({ userAgent: longUA.slice(0, 512) }));
  });
});

describe("handleProxyRequest - quota", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("returns 429 quota_exceeded and never fetches when rpm exceeded", async () => {
    const deps = mkDeps({
      resolveVirtualKey: vi.fn(async () => ({
        id: 1,
        name: "claude-code",
        enabled: true,
        enabledModels: ["*"],
        maxRpm: 60,
        maxTpm: null,
        maxDailyTokens: null,
        maxMonthlyTokens: null,
      })),
      quota: {
        loadUsage: vi.fn(async () => ({ rpm: 61, tpm: 0, dailyTokens: 0, monthlyTokens: 0 })),
      },
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.error.type).toBe("quota_exceeded");
    expect(fetchMock).not.toHaveBeenCalled();
    expect(deps.onUsage).not.toHaveBeenCalled();
    expect(deps.onComplete).not.toHaveBeenCalled();
  });

  it("forwards normally when within quota and calls onUsage", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ usage: { prompt_tokens: 10, completion_tokens: 5 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );

    const deps = mkDeps({
      resolveVirtualKey: vi.fn(async () => ({
        id: 1,
        name: "claude-code",
        enabled: true,
        enabledModels: ["*"],
        maxRpm: 60,
        maxTpm: 100_000,
        maxDailyTokens: 1_000_000,
        maxMonthlyTokens: 10_000_000,
      })),
      quota: {
        loadUsage: vi.fn(async () => ({ rpm: 59, tpm: 100, dailyTokens: 1000, monthlyTokens: 10000 })),
      },
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    await res.text();

    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deps.onUsage).toHaveBeenCalled();
  });

  it("returns 429 when tpm exceeded even if rpm ok", async () => {
    const deps = mkDeps({
      resolveVirtualKey: vi.fn(async () => ({
        id: 1,
        name: "claude-code",
        enabled: true,
        enabledModels: ["*"],
        maxRpm: 60,
        maxTpm: 100_000,
        maxDailyTokens: null,
        maxMonthlyTokens: null,
      })),
      quota: {
        loadUsage: vi.fn(async () => ({ rpm: 5, tpm: 100_001, dailyTokens: 0, monthlyTokens: 0 })),
      },
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o" },
      }),
      deps
    );
    expect(res.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("handleProxyRequest - cross-upstream failover & session stickiness", () => {
  const fetchMock = vi.fn();
  const sessionId = buildSessionId(
    { messages: [{ role: "user", content: "hi" }] },
    "gpt-4o",
    1,
    "openai"
  );

  function mkUpstreams(): UpstreamRoute[] {
    return [
      mkUpstream({ id: 1, name: "openai-primary", baseUrl: "https://primary.example", priority: 0 }),
      mkUpstream({ id: 2, name: "openai-alt", baseUrl: "https://alt.example", priority: 1 }),
    ];
  }

  function mkFailoverDeps(overrides: Partial<ProxyDeps> = {}): {
    deps: ProxyDeps;
    getBinding: ReturnType<typeof vi.fn>;
    setBinding: ReturnType<typeof vi.fn>;
    isHealthy: ReturnType<typeof vi.fn>;
    markUnhealthy: ReturnType<typeof vi.fn>;
  } {
    const getBinding = vi.fn();
    const setBinding = vi.fn();
    const isHealthy = vi.fn(() => true);
    const markUnhealthy = vi.fn();
    const deps = mkDeps({
      loadUpstreams: vi.fn(async () => mkUpstreams()),
      resolveUpstreamKeys: vi.fn(async () => ["key-1"]),
      session: { getBinding, setBinding },
      health: { isHealthy, markUnhealthy },
      ...overrides,
    });
    return { deps, getBinding, setBinding, isHealthy, markUnhealthy };
  }

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("does not create binding when default upstream succeeds", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const { deps, getBinding, setBinding } = mkFailoverDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(getBinding).toHaveBeenCalledWith(sessionId);
    expect(setBinding).not.toHaveBeenCalled();
  });

  it("fails over to next upstream when default is down and creates binding", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("https://alt.example")
        ? Promise.resolve(
            new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          )
        : Promise.resolve(new Response("server error", { status: 503 }))
    );
    const { deps, setBinding, markUnhealthy } = mkFailoverDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(markUnhealthy).toHaveBeenCalledWith(1);
    expect(setBinding).toHaveBeenCalledWith(sessionId, 2);
  });

  it("records usage with actual fallback upstream provider", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("https://alt.example")
        ? Promise.resolve(
            new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          )
        : Promise.resolve(new Response("server error", { status: 503 }))
    );
    const { deps } = mkFailoverDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(deps.onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai-alt", model: "gpt-4o" })
    );
  });

  it("prefers bound (sticky) upstream over default even when default is healthy", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("https://alt.example")
        ? Promise.resolve(
            new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          )
        : Promise.resolve(new Response("should not be called", { status: 200 }))
    );
    const getBinding = vi.fn(() => ({ upstreamId: 2, boundAt: Date.now() }));
    const { deps } = mkFailoverDeps({ session: { getBinding, setBinding: vi.fn() } });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(getBinding).toHaveBeenCalledWith(sessionId);
    expect(fetchMock).toHaveBeenCalledTimes(1); // 只请求 alt
    expect(fetchMock.mock.calls[0][0]).toContain("alt.example");
  });

  it("skips unhealthy upstream and routes to healthy one", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const { deps, isHealthy } = mkFailoverDeps();
    isHealthy.mockImplementation((id: number) => id !== 1);
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain("alt.example");
    expect(deps.onUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai-alt" }));
  });

  it("discards binding pointing to unhealthy upstream", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const { deps, isHealthy } = mkFailoverDeps({
      session: {
        getBinding: vi.fn(() => ({ upstreamId: 2, boundAt: Date.now() })),
        setBinding: vi.fn(),
      },
    });
    isHealthy.mockImplementation((id: number) => id !== 2);
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(fetchMock.mock.calls[0][0]).toContain("primary.example");
  });

  it("returns 502 and marks all upstreams unhealthy when all fail", async () => {
    fetchMock.mockResolvedValue(new Response("server error", { status: 503 }));
    const { deps, markUnhealthy } = mkFailoverDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    expect(res.status).toBe(502);
    expect(markUnhealthy).toHaveBeenCalledWith(1);
    expect(markUnhealthy).toHaveBeenCalledWith(2);
  });

  it("returns 502 without fetching when all upstreams unhealthy", async () => {
    const { deps, isHealthy } = mkFailoverDeps();
    isHealthy.mockReturnValue(false);
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    expect(res.status).toBe(502);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("skips session computation with a single candidate", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const getBinding = vi.fn();
    const deps = mkDeps({
      loadUpstreams: vi.fn(async () => [mkUpstream({ id: 1, name: "solo" })]),
      resolveUpstreamKeys: vi.fn(async () => ["key-1"]),
      session: { getBinding, setBinding: vi.fn() },
      health: { isHealthy: vi.fn(() => true), markUnhealthy: vi.fn() },
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(getBinding).not.toHaveBeenCalled();
  });

  it("keeps key-level retry within a failed upstream before moving on", async () => {
    const { deps } = mkFailoverDeps();
    fetchMock
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(3); // primary 重试 2 次 + alt 成功
  });

  it("passes 4xx through without failover or health change", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("https://alt.example")
        ? Promise.resolve(
            new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          )
        : Promise.resolve(
            new Response(JSON.stringify({ error: { message: "bad request" } }), {
              status: 400,
              headers: { "content-type": "application/json" },
            })
          )
    );
    const { deps, markUnhealthy } = mkFailoverDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(400);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(markUnhealthy).not.toHaveBeenCalled();
  });

  it("moves to next key when current key returns 401", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("unauthorized", { status: 401 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    const deps = mkDeps({
      loadUpstreams: vi.fn(async () => [mkUpstream({ id: 1, name: "multi-key" })]),
      resolveUpstreamKeys: vi.fn(async () => ["bad-key", "good-key"]),
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2); // bad-key 401 不重试直接换 key
  });

  it("fails over to next upstream when all keys return 401 and marks unhealthy", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("https://alt.example")
        ? Promise.resolve(
            new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          )
        : Promise.resolve(new Response("unauthorized", { status: 401 }))
    );
    const { deps, markUnhealthy } = mkFailoverDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2); // primary 401 不重试 → alt 成功
    expect(fetchMock.mock.calls[1][0]).toContain("alt.example");
    expect(markUnhealthy).toHaveBeenCalledWith(1);
    expect(deps.onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai-alt" })
    );
  });

  it("fails over to next upstream on 404 and marks model-level unavailable only", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("https://alt.example")
        ? Promise.resolve(
            new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          )
        : Promise.resolve(new Response("model not found", { status: 404 }))
    );
    const markModelUnhealthy = vi.fn();
    const { deps, markUnhealthy } = mkFailoverDeps({
      health: {
        isHealthy: vi.fn(() => true),
        markUnhealthy: vi.fn(),
        isModelHealthy: vi.fn(() => true),
        markModelUnhealthy,
      },
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markModelUnhealthy).toHaveBeenCalledWith(1, "gpt-4o");
    expect(markUnhealthy).not.toHaveBeenCalled(); // 404 不标记 upstream unhealthy
    expect(deps.onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai-alt" })
    );
  });

  it("passes through 404 when all candidates return 404 and marks them", async () => {
    fetchMock.mockResolvedValue(new Response("model not found", { status: 404 }));
    const markModelUnhealthy = vi.fn();
    const { deps, markUnhealthy } = mkFailoverDeps({
      health: {
        isHealthy: vi.fn(() => true),
        markUnhealthy: vi.fn(),
        isModelHealthy: vi.fn(() => true),
        markModelUnhealthy,
      },
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    const body = await res.text();
    expect(res.status).toBe(404);
    expect(body).toContain("model not found");
    expect(markModelUnhealthy).toHaveBeenCalledWith(1, "gpt-4o");
    expect(markModelUnhealthy).toHaveBeenCalledWith(2, "gpt-4o");
    expect(markUnhealthy).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips upstream whose model is marked unavailable", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const isModelHealthy = vi.fn((id: number) => id !== 1);
    const { deps } = mkFailoverDeps({
      health: {
        isHealthy: vi.fn(() => true),
        markUnhealthy: vi.fn(),
        isModelHealthy,
        markModelUnhealthy: vi.fn(),
      },
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain("alt.example");
    expect(deps.onUsage).toHaveBeenCalledWith(expect.objectContaining({ provider: "openai-alt" }));
  });

  it("marks model-level unavailable when all keys return 403 and fails over", async () => {
    fetchMock.mockImplementation((url: string) =>
      url.startsWith("https://alt.example")
        ? Promise.resolve(
            new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
              status: 200,
              headers: { "content-type": "application/json" },
            })
          )
        : Promise.resolve(new Response("forbidden", { status: 403 }))
    );
    const markModelUnhealthy = vi.fn();
    const { deps, markUnhealthy } = mkFailoverDeps({
      health: {
        isHealthy: vi.fn(() => true),
        markUnhealthy: vi.fn(),
        isModelHealthy: vi.fn(() => true),
        markModelUnhealthy,
      },
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(markModelUnhealthy).toHaveBeenCalledWith(1, "gpt-4o");
    expect(markUnhealthy).not.toHaveBeenCalled(); // 403 不标记 upstream unhealthy
    expect(deps.onUsage).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "openai-alt" })
    );
  });

  it("tries next key on 403 before failing over", async () => {
    fetchMock
      .mockResolvedValueOnce(new Response("forbidden", { status: 403 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      );
    const { deps } = mkFailoverDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("passes through 403 when all candidates return 403", async () => {
    fetchMock.mockResolvedValue(new Response("forbidden", { status: 403 }));
    const { deps } = mkFailoverDeps();
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    const body = await res.text();
    expect(res.status).toBe(403);
    expect(body).toContain("forbidden");
  });

  it("dedupes upstream matched by both exact and wildcard patterns", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ usage: { prompt_tokens: 1, completion_tokens: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const deps = mkDeps({
      loadUpstreams: vi.fn(async () => [
        mkUpstream({ id: 1, name: "dup", enabledModels: ["gpt-4o", "gpt-*"] }),
      ]),
      resolveUpstreamKeys: vi.fn(async () => ["key-1"]),
      session: { getBinding: vi.fn(), setBinding: vi.fn() },
      health: { isHealthy: vi.fn(() => true), markUnhealthy: vi.fn() },
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/chat/completions", {
        headers: { authorization: "Bearer vk-good" },
        body: { model: "gpt-4o", messages: [{ role: "user", content: "hi" }] },
      }),
      deps
    );
    await res.text();
    expect(res.status).toBe(200);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("handleProxyRequest - GET /v1/models", () => {
  it("returns union of enabled models across upstreams", async () => {
    const deps = mkDeps({
      loadUpstreams: vi.fn(async () => [
        mkUpstream({ name: "a", enabledModels: ["gpt-4o", "gpt-4o-mini"] }),
        mkUpstream({ id: 2, name: "b", enabledModels: ["claude-3-5-sonnet", "gpt-*"] }),
      ]),
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/models", { method: "GET", headers: { authorization: "Bearer vk-good" } }),
      deps
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.data.map((m: any) => m.id);
    expect(ids).toContain("gpt-4o");
    expect(ids).toContain("gpt-4o-mini");
    expect(ids).toContain("claude-3-5-sonnet");
    expect(ids).not.toContain("gpt-*"); // 通配符不暴露
  });

  it("filters model list by virtual key enabledModels", async () => {
    const deps = mkDeps({
      resolveVirtualKey: vi.fn(async () => ({
        id: 1,
        name: "limited",
        enabled: true,
        enabledModels: ["gpt-*"],
      })),
      loadUpstreams: vi.fn(async () => [
        mkUpstream({ name: "a", enabledModels: ["gpt-4o", "claude-3-5-sonnet"] }),
      ]),
    });
    const res = await handleProxyRequest(
      makeRequest("/v1/models", { method: "GET", headers: { authorization: "Bearer vk-good" } }),
      deps
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    const ids = json.data.map((m: any) => m.id);
    expect(ids).toEqual(["gpt-4o"]);
  });
});
