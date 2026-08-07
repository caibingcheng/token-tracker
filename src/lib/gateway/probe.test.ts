import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { buildProbeRequest, probeModel, PROBE_TIMEOUT_MS } from "./probe";

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

  it("returns ok for 2xx", async () => {
    fetchMock.mockResolvedValue(new Response("{}", { status: 200 }));
    const result = await probeModel(
      { protocol: "openai", baseUrl: "https://api.example" },
      "gpt-4o",
      "sk-test"
    );
    expect(result).toEqual({ ok: true, status: 200 });
  });

  it("returns error with body snippet for non-2xx", async () => {
    fetchMock.mockResolvedValue(
      new Response("{\"error\":{\"message\":\"model not found\"}}", { status: 404 })
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
