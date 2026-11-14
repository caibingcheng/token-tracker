import { describe, it, expect, vi, afterEach } from "vitest";
import {
  fetchBalance,
  detectBalanceProvider,
  resolveBalanceMode,
  isBalanceFetchMode,
  normalizeBalanceFetchMode,
} from "./balance";
import { getDirectDispatcher } from "./proxy-dispatcher";
import { setOutboundFetchImpl } from "./outbound-fetch";

afterEach(() => {
  vi.unstubAllGlobals();
    setOutboundFetchImpl(null);
});

describe("detectBalanceProvider", () => {
  it("detects deepseek by host", () => {
    expect(detectBalanceProvider("https://api.deepseek.com")).toBe("deepseek");
    expect(detectBalanceProvider("https://api.deepseek.com/v1")).toBe("deepseek");
  });

  it("requires hostname match: lookalike domains are not detected", () => {
    // 子串包含会让这些域名命中，随后自动刷新会把该 upstream 的 key 发给官方端点
    expect(detectBalanceProvider("https://deepseek.example.com")).toBeNull();
    expect(detectBalanceProvider("https://my-ollama.com/v1")).toBeNull();
    expect(detectBalanceProvider("https://ollama.com.evil.example/v1")).toBeNull();
    expect(detectBalanceProvider("https://openrouter.ai.evil.example/v1")).toBeNull();
    expect(detectBalanceProvider("https://relay.example.com/ollama.com/v1")).toBeNull();
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

  it("detects kimi / kimi-coding / glm / opencode-go", () => {
    expect(detectBalanceProvider("https://api.moonshot.cn/v1")).toBe("kimi");
    expect(detectBalanceProvider("https://api.moonshot.ai/v1")).toBe("kimi");
    expect(detectBalanceProvider("https://api.kimi.com/coding")).toBe("kimi-coding");
    expect(detectBalanceProvider("https://api.kimi.com/coding/anthropic")).toBe("kimi-coding");
    expect(detectBalanceProvider("https://api.z.ai/v1")).toBe("glm");
    expect(detectBalanceProvider("https://open.bigmodel.cn/api/paas/v4")).toBe("glm");
    expect(detectBalanceProvider("https://opencode.ai/v1")).toBe("opencode-go");
    expect(detectBalanceProvider("https://ollama.com/v1")).toBe("ollama-cloud");
    expect(detectBalanceProvider("https://ollama.com/api")).toBe("ollama-cloud");
    expect(detectBalanceProvider("https://ollama.ai/v1")).toBe("ollama-cloud");
    expect(detectBalanceProvider("https://api.ollama.com/v1")).toBe("ollama-cloud");
    // 合法 DNS 尾点（WHATWG URL 会保留）不能漏判
    expect(detectBalanceProvider("https://ollama.com./v1")).toBe("ollama-cloud");
  });

  it("falls back to name keywords only for baseUrl-derived endpoints", () => {
    expect(detectBalanceProvider("https://relay.example.com/v1", "kimi-main")).toBe("kimi");
    // Kimi for Coding 的 endpoint 固定为 api.kimi.com，不能靠 name 触发
    expect(detectBalanceProvider("https://relay.example.com/v1", "Kimi for Coding")).toBe("kimi");
    expect(detectBalanceProvider("https://relay.example.com/v1", "glm-zai")).toBe("glm");
    expect(detectBalanceProvider("https://relay.example.com/v1", "DeepSeek Relay")).toBe("deepseek");
    expect(detectBalanceProvider("https://relay.example.com/v1", "random")).toBeNull();
    // 固定端点 provider 只能靠 hostname 命中：否则本地/自建上游的 key 会被发往官方域名
    expect(detectBalanceProvider("http://localhost:11434/v1", "Ollama")).toBeNull();
    expect(detectBalanceProvider("https://relay.example.com/v1", "Ollama Cloud")).toBeNull();
    expect(detectBalanceProvider("https://relay.example.com/v1", "opencode go")).toBeNull();
    expect(detectBalanceProvider("https://relay.example.com/v1", "openrouter")).toBeNull();
  });

  it("URL match wins over name", () => {
    expect(detectBalanceProvider("https://api.z.ai/v1", "kimi")).toBe("glm");
  });
});

describe("resolveBalanceMode", () => {
  it("auto resolves by URL, manual mode bypasses detection", () => {
    expect(resolveBalanceMode("https://api.moonshot.cn/v1", "auto")).toBe("kimi");
    expect(resolveBalanceMode("https://example.com/v1", "auto")).toBeNull();
    expect(resolveBalanceMode("https://example.com/v1", "kimi")).toBe("kimi");
    expect(resolveBalanceMode("https://api.moonshot.cn/v1", "none")).toBeNull();
  });

  it("isBalanceFetchMode validates mode values", () => {
    expect(isBalanceFetchMode("auto")).toBe(true);
    expect(isBalanceFetchMode("none")).toBe(true);
    expect(isBalanceFetchMode("kimi-coding")).toBe(true);
    expect(isBalanceFetchMode("bailian")).toBe(false);
    expect(isBalanceFetchMode(123)).toBe(false);
  });

  it("normalizeBalanceFetchMode falls back to auto for invalid stored values", () => {
    expect(normalizeBalanceFetchMode("kimi")).toBe("kimi");
    expect(normalizeBalanceFetchMode("none")).toBe("none");
    expect(normalizeBalanceFetchMode("bailian")).toBe("auto");
    expect(normalizeBalanceFetchMode(null)).toBe("auto");
    expect(normalizeBalanceFetchMode(undefined)).toBe("auto");
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
    setOutboundFetchImpl(fetchMock);

    const result = await fetchBalance("https://api.deepseek.com", "sk-test");
    expect(result).toEqual({ balance: "115.5", currency: "CNY" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/user/balance");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-test");
  });

  it("injects dispatcher when proxyUrl provided", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "1" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    setOutboundFetchImpl(fetchMock);

    await fetchBalance(
      "https://api.deepseek.com",
      "sk-test",
      "https://user:pass@proxy.example:3128"
    );
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    expect(init.dispatcher).toBeDefined();
  });

  it("injects the guarded direct dispatcher when there is no proxyUrl", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ balance_infos: [{ currency: "CNY", total_balance: "1" }] }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    setOutboundFetchImpl(fetchMock);

    await fetchBalance("https://api.deepseek.com", "sk-test");
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit & { dispatcher?: unknown }];
    // 无 proxyUrl 时也必须注入受连接时地址校验保护的直连 Agent（防 DNS rebinding）
    expect("dispatcher" in init).toBe(true);
    expect(init.dispatcher).toBe(getDirectDispatcher());
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
    setOutboundFetchImpl(fetchMock);
    const result = await fetchBalance("https://api.deepseek.com", "sk-test");
    expect(result.balance).toBe("120");
  });

  it("throws on non-2xx response", async () => {
    setOutboundFetchImpl(vi.fn(async () => new Response("unauthorized", { status: 401 })));
    await expect(fetchBalance("https://api.deepseek.com", "bad")).rejects.toThrow(
      "401"
    );
  });

  it("throws on malformed payload", async () => {
    setOutboundFetchImpl(vi.fn(async () => new Response(JSON.stringify({ foo: 1 }), { status: 200 })));
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
    setOutboundFetchImpl(fetchMock);

    const result = await fetchBalance("https://openrouter.ai/api/v1", "sk-test");
    expect(result).toEqual({ balance: "8800", currency: "USD" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://openrouter.ai/api/v1/auth/key");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-test");
  });

  it("returns unknown when limit is null", async () => {
    setOutboundFetchImpl(vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { usage: 10, limit: null } }),
          { status: 200 }
        )
      ));
    const result = await fetchBalance("https://openrouter.ai", "sk-test");
    expect(result.balance).toBe("unknown");
  });

  it("clamps negative remaining to zero", async () => {
    setOutboundFetchImpl(vi.fn(async () =>
        new Response(
          JSON.stringify({ data: { usage: 120, limit: 100 } }),
          { status: 200 }
        )
      ));
    const result = await fetchBalance("https://openrouter.ai", "sk-test");
    expect(result.balance).toBe("0");
  });

  it("throws on non-2xx", async () => {
    setOutboundFetchImpl(vi.fn(async () => new Response("bad", { status: 500 })));
    await expect(fetchBalance("https://openrouter.ai", "bad")).rejects.toThrow("500");
  });
});

describe("fetchBalance - kimi", () => {
  it("reads available_balance (CNY), joins /v1 aware path", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 0,
          data: { available_balance: 49.58894, voucher_balance: 46.5, cash_balance: 3.08 },
          status: true,
        }),
        { status: 200 }
      )
    );
    setOutboundFetchImpl(fetchMock);

    const result = await fetchBalance("https://api.moonshot.cn/v1", "sk-test");
    expect(result).toEqual({ balance: "49.58894", currency: "CNY" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.moonshot.cn/v1/users/me/balance");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-test");
    expect(init.redirect).toBe("manual");
  });

  it("appends /v1 path when baseUrl has no version prefix", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 0, data: { available_balance: 1 } }),
        { status: 200 }
      )
    );
    setOutboundFetchImpl(fetchMock);

    await fetchBalance("https://api.moonshot.ai", "sk-test");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.moonshot.ai/v1/users/me/balance");
  });

  it("throws on malformed payload", async () => {
    setOutboundFetchImpl(vi.fn(async () => new Response(JSON.stringify({ code: 0 }), { status: 200 })));
    await expect(fetchBalance("https://api.moonshot.cn/v1", "sk-test")).rejects.toThrow();
  });
});

describe("fetchBalance - kimi-coding", () => {
  const USAGES_URL = "https://api.kimi.com/coding/v1/usages";

  it("summarizes window percentages, reset countdown and booster wallet", async () => {
    const now = Date.now();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          usage: {
            limit: 5000,
            remaining: 3000,
            resetTime: new Date(now + 4 * 86_400_000).toISOString(),
          },
          limits: [
            {
              window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
              detail: {
                limit: 1000,
                used: 230,
                resetTime: new Date(now + 80 * 60_000).toISOString(),
              },
            },
          ],
          boosterWallet: {
            balance: { type: "BOOSTER", amount: "50000000", amountLeft: "12300000" },
          },
        }),
        { status: 200 }
      )
    );
    setOutboundFetchImpl(fetchMock);

    const result = await fetchBalance("https://api.kimi.com/coding", "sk-test");
    // 5h: 230/1000=23%，reset 80m→1h；weekly: used=5000-3000=2000 → 40%，reset 4d；booster → $0.12
    expect(result).toEqual({
      balance: "5h 23% (1h) · wk 40% (4d) (Extra $0.12)",
      currency: "",
    });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(USAGES_URL);
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-test");
  });

  it("dedupes weekly window already present in limits", async () => {
    setOutboundFetchImpl(vi.fn(async () =>
        new Response(
          JSON.stringify({
            usage: { limit: 100, remaining: 50 },
            limits: [
              {
                window: { duration: 7, timeUnit: "TIME_UNIT_DAY" },
                detail: { limit: 100, used: 60 },
              },
            ],
          }),
          { status: 200 }
        )
      ));
    const result = await fetchBalance("https://api.kimi.com/coding", "sk-test");
    // 7d 窗口与 usage 周窗口归一为 wk 并去重，保留 limits 里的 60%
    expect(result.balance).toBe("wk 60%");
  });

  it("throws when no window is computable", async () => {
    setOutboundFetchImpl(vi.fn(async () => new Response(JSON.stringify({ limits: [] }), { status: 200 })));
    await expect(fetchBalance("https://api.kimi.com/coding", "sk-test")).rejects.toThrow();
  });
});

describe("fetchBalance - glm", () => {
  it("uses bare key auth and maps unit 3/6 + TIME_LIMIT windows with reset countdown", async () => {
    const now = Date.now();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          success: true,
          data: {
            limits: [
              { type: "TOKENS_LIMIT", unit: 3, percentage: 44.4, nextResetTime: now + 2 * 3600_000 },
              { type: "TOKENS_LIMIT", unit: 6, percentage: 61, nextResetTime: now + 3 * 86_400_000 },
              { type: "TIME_LIMIT", usage: 1000, currentValue: 72 },
            ],
            level: "pro",
          },
        }),
        { status: 200 }
      )
    );
    setOutboundFetchImpl(fetchMock);

    const result = await fetchBalance("https://api.z.ai/v1", "sk-test");
    expect(result).toEqual({ balance: "5h 44% (2h) · wk 61% (3d) · mo 7% · pro", currency: "" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.z.ai/api/monitor/usage/quota/limit");
    // GLM 要求裸 key，不带 Bearer 前缀
    expect(new Headers(init.headers).get("authorization")).toBe("sk-test");
  });

  it("uses bigmodel.cn mirror for CN baseUrl", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          code: 200,
          success: true,
          data: { limits: [{ type: "TOKENS_LIMIT", unit: 3, percentage: 10 }] },
        }),
        { status: 200 }
      )
    );
    setOutboundFetchImpl(fetchMock);

    const result = await fetchBalance("https://open.bigmodel.cn/api/paas/v4", "sk-test");
    expect(result.balance).toBe("5h 10%");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://open.bigmodel.cn/api/monitor/usage/quota/limit");
  });

  it("surfaces API error message (e.g. pay-as-you-go key)", async () => {
    setOutboundFetchImpl(vi.fn(async () =>
        new Response(
          JSON.stringify({ code: 500, success: false, msg: "quota not available" }),
          { status: 200 }
        )
      ));
    await expect(fetchBalance("https://api.z.ai/v1", "sk-test")).rejects.toThrow(
      "quota not available"
    );
  });
});

describe("fetchBalance - opencode-go", () => {
  it("summarizes rolling/weekly/monthly percents with reset countdown", async () => {
    const now = Date.now();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          usage: {
            rolling: { percent: 10.4, resetsAt: new Date(now + 75 * 60_000).toISOString() },
            weekly: { percent: 35 },
            monthly: { percent: 62.6, resetsAt: new Date(now + 25 * 86_400_000).toISOString() },
          },
        }),
        { status: 200 }
      )
    );
    setOutboundFetchImpl(fetchMock);

    const result = await fetchBalance("https://opencode.ai/v1", "oc_sk_test");
    expect(result).toEqual({ balance: "5h 10% (1h) · wk 35% · mo 63% (25d)", currency: "" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://opencode.ai/zen/go/v1/usage");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer oc_sk_test");
  });

  it("throws when usage is missing", async () => {
    setOutboundFetchImpl(vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    await expect(fetchBalance("https://opencode.ai/v1", "bad")).rejects.toThrow();
  });
});

describe("fetchBalance - ollama-cloud", () => {
  it("reports included/purchased credits with period countdown", async () => {
    const until = new Date(Date.now() + 12 * 86_400_000).toISOString();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          included: {
            balance_usd: 72.5,
            allowance_usd: 100,
            period: { from: new Date(Date.now() - 18 * 86_400_000).toISOString(), until },
          },
          purchased: { balance_usd: 25 },
        }),
        { status: 200 }
      )
    );
    setOutboundFetchImpl(fetchMock);

    const result = await fetchBalance("https://ollama.com/v1", "ollama_sk_test");
    expect(result).toEqual({ balance: "$72.50/$100.00 + $25.00 (12d)", currency: "" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://ollama.com/api/balance");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer ollama_sk_test");
    expect(init.redirect).toBe("manual");
  });

  it("converts legacy session/weekly remaining percent into used windows", async () => {
    setOutboundFetchImpl(
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            included: {
              session: {
                remaining_percent: 75,
                resets_at: new Date(Date.now() + 2 * 3_600_000).toISOString(),
              },
              weekly: { remaining_percent: 40 },
            },
            purchased: { balance_usd: 0 },
          }),
          { status: 200 }
        )
      )
    );

    const result = await fetchBalance("https://ollama.com/v1", "ollama_sk_test");
    expect(result).toEqual({ balance: "5h 25% (2h) · wk 60%", currency: "" });
  });

  it("throws on unexpected payload and on non-ok status", async () => {
    setOutboundFetchImpl(vi.fn(async () => new Response(JSON.stringify({}), { status: 200 })));
    await expect(fetchBalance("https://ollama.com/v1", "bad")).rejects.toThrow();

    setOutboundFetchImpl(vi.fn(async () => new Response("nope", { status: 401 })));
    await expect(fetchBalance("https://ollama.com/v1", "bad")).rejects.toThrow(
      "Ollama Cloud balance API returned 401"
    );

    // 429 限流（10 req/min/用户）：同样只报状态码，不污染已有 balance
    setOutboundFetchImpl(vi.fn(async () => new Response("", { status: 429 })));
    await expect(fetchBalance("https://ollama.com/v1", "bad")).rejects.toThrow(
      "Ollama Cloud balance API returned 429"
    );

    // 200 但 body 不是 JSON
    setOutboundFetchImpl(vi.fn(async () => new Response("<html>", { status: 200 })));
    await expect(fetchBalance("https://ollama.com/v1", "bad")).rejects.toThrow();
  });

  it("rejects non-finite / null numeric fields instead of showing $0.00", async () => {
    // Number(null) === 0，不做 typeof 检查会显示成 $0.00
    setOutboundFetchImpl(
      vi.fn(async () =>
        new Response(
          JSON.stringify({ included: { balance_usd: null, allowance_usd: 100 } }),
          { status: 200 }
        )
      )
    );
    await expect(fetchBalance("https://ollama.com/v1", "k")).rejects.toThrow(
      "Unexpected Ollama Cloud balance response"
    );

    // JSON 数字 1e400 → Infinity：不能算成 0% 已用，回落金额分支
    setOutboundFetchImpl(
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            included: {
              balance_usd: 3,
              session: { remaining_percent: 1e400 },
            },
          }),
          { status: 200 }
        )
      )
    );
    expect(await fetchBalance("https://ollama.com/v1", "k")).toEqual({
      balance: "$3.00",
      currency: "",
    });
  });
});

describe("fetchBalance - manual mode dispatch", () => {
  it("manual mode bypasses URL detection", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({ code: 0, data: { available_balance: 2 } }),
        { status: 200 }
      )
    );
    setOutboundFetchImpl(fetchMock);

    // baseUrl 不可识别，但手动指定 kimi 模式仍按 kimi 接口拉取
    const result = await fetchBalance("https://relay.example.com/v1", "sk-test", undefined, "kimi");
    expect(result.balance).toBe("2");
    const [url] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.example.com/v1/users/me/balance");
  });

  it("none mode always throws", async () => {
    await expect(
      fetchBalance("https://api.moonshot.cn/v1", "sk-test", undefined, "none")
    ).rejects.toThrow("not supported");
  });
});
