import { describe, it, expect, vi, afterEach } from "vitest";
import { fetchBalance, detectBalanceProvider } from "./balance";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("detectBalanceProvider", () => {
  it("detects deepseek by host", () => {
    expect(detectBalanceProvider("https://api.deepseek.com")).toBe("deepseek");
    expect(detectBalanceProvider("https://api.deepseek.com/v1")).toBe("deepseek");
    expect(detectBalanceProvider("https://deepseek.example.com")).toBe("deepseek");
  });

  it("detects openrouter by host", () => {
    expect(detectBalanceProvider("https://openrouter.ai/api/v1")).toBe("openrouter");
    expect(detectBalanceProvider("https://openrouter.ai")).toBe("openrouter");
  });

  it("returns null for unsupported providers", () => {
    expect(detectBalanceProvider("https://api.openai.com/v1")).toBeNull();
    expect(detectBalanceProvider("https://example.com")).toBeNull();
  });

  it("case-insensitive on host", () => {
    expect(detectBalanceProvider("HTTPS://API.DEEPSEEK.COM")).toBe("deepseek");
  });
});

describe("fetchBalance - deepseek", () => {
  it("sums total_balance across currencies and uses first currency", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          is_available: true,
          balance_infos: [
            { currency: "CNY", total_balance: "110.00", granted_balance: "10.00" },
            { currency: "USD", total_balance: "5.50" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBalance("https://api.deepseek.com", "sk-test");
    expect(result).toEqual({ balance: "115.5", currency: "CNY" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/user/balance");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-test");
  });

  it("handles string or numeric total_balance", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          balance_infos: [
            { currency: "CNY", total_balance: "100" },
            { currency: "CNY", total_balance: 20 },
          ],
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);
    const result = await fetchBalance("https://api.deepseek.com", "sk-test");
    expect(result.balance).toBe("120");
  });

  it("throws on non-2xx response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("unauthorized", { status: 401 }))
    );
    await expect(fetchBalance("https://api.deepseek.com", "bad")).rejects.toThrow(
      "401"
    );
  });

  it("throws on malformed payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ foo: 1 }), { status: 200 }))
    );
    await expect(fetchBalance("https://api.deepseek.com", "sk-test")).rejects.toThrow();
  });

  it("throws for unsupported provider", async () => {
    await expect(fetchBalance("https://api.openai.com/v1", "sk-test")).rejects.toThrow(
      "not supported"
    );
  });
});

describe("fetchBalance - openrouter", () => {
  it("computes remaining as limit - usage", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          data: { label: "test", usage: 1200, limit: 10000, is_free_tier: false },
        }),
        { status: 200 }
      )
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchBalance("https://openrouter.ai/api/v1", "sk-test");
    expect(result).toEqual({ balance: "8800", currency: "USD" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/auth/key");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-test");
  });

  it("returns unknown when limit is null", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { usage: 10, limit: null } }),
          { status: 200 }
        )
      )
    );
    const result = await fetchBalance("https://openrouter.ai", "sk-test");
    expect(result.balance).toBe("unknown");
  });

  it("clamps negative remaining to zero", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { usage: 120, limit: 100 } }),
          { status: 200 }
        )
      )
    );
    const result = await fetchBalance("https://openrouter.ai", "sk-test");
    expect(result.balance).toBe("0");
  });

  it("throws on non-2xx", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("bad", { status: 500 }))
    );
    await expect(fetchBalance("https://openrouter.ai", "bad")).rejects.toThrow("500");
  });
});
