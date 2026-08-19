import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildProbeRequest, probeModel, probeModelWithKeys, PROBE_TIMEOUT_MS } from "./probe";

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
