import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { fetchUpstreamModels } from "./upstream-client";

describe("fetchUpstreamModels", () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  it("uses redirect: manual and does not follow 3xx (credential leak guard)", async () => {
    fetchMock.mockResolvedValue(
      new Response("redirecting", {
        status: 302,
        headers: { location: "https://evil.example/steal" },
      })
    );
    const result = await fetchUpstreamModels(
      { protocol: "openai", baseUrl: "https://api.example" },
      "sk-test"
    );
    expect(result.models).toEqual([]);
    expect(result.status).toBe(302);
    expect(result.error).toContain("redirect");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.example/models");
    expect((init as RequestInit & { redirect?: string }).redirect).toBe("manual");
  });

  it("parses models from successful response", async () => {
    fetchMock.mockResolvedValue(
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })
    );
    const result = await fetchUpstreamModels(
      { protocol: "openai", baseUrl: "https://api.example" },
      "sk-test"
    );
    expect(result.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(result.status).toBe(200);
    expect(result.error).toBeUndefined();
  });
});
