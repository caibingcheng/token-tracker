import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { jevSystemoneAdapter } from "./adapters/jev-systemone";
import { chatAdapter } from "./adapters/chat";
import { buildStateSummary, extractMessageTexts, estimateTokens } from "./summarize";
import { lookupContextWindow, resolveInputBudget } from "./budget";
import { parseClassifierModels, isValidClassifierModelEntry, estimateOverheadTokens } from "./types";
import { runClassifier } from "./index";
import type { ClassifierRouteOption } from "./types";
import type { UpstreamRoute } from "../model-router";

const options: ClassifierRouteOption[] = [
  { key: "r1", routeId: 1, label: "gpt-4o-mini — 简单问答、格式化、短文本" },
  { key: "r2", routeId: 2, label: "claude-opus — 复杂推理、代码、长文分析" },
];

describe("jev-systemone adapter", () => {
  it("builds a choice question with criteria map", () => {
    const req = jevSystemoneAdapter.buildRequest(
      "jev-latest",
      { instruction: "按复杂度选路由", options, state: "[user] hi" },
      { model: "jev-latest", type: "jev-systemone" }
    );
    expect(req.path).toBe("/v1/systemone");
    expect(req.body).toEqual({
      model: "jev-latest",
      state: "[user] hi",
      questions: {
        route: {
          type: "choice",
          instructions: "按复杂度选路由",
          criteria: {
            r1: "gpt-4o-mini — 简单问答、格式化、短文本",
            r2: "claude-opus — 复杂推理、代码、长文分析",
          },
        },
      },
    });
  });

  it("honors entry.path override (OpenRouter /alpha/decisions)", () => {
    const req = jevSystemoneAdapter.buildRequest(
      "typesafe/jev-1.13",
      { instruction: "", options, state: "s" },
      { model: "typesafe/jev-1.13", type: "jev-systemone", path: "/alpha/decisions" }
    );
    expect(req.path).toBe("/alpha/decisions");
    // instruction 为空时用默认指令
    const q = (req.body.questions as any).route;
    expect(q.instructions.length).toBeGreaterThan(0);
  });

  it("parses choice answer back to routeId, with usage", () => {
    const decision = jevSystemoneAdapter.parseResponse(
      {
        model: "jev-1.13.0",
        answers: {
          route: { type: "choice", choice: "r2", probabilities: { r1: 0.1, r2: 0.9 }, confidence: 0.8 },
        },
        usage: { input_tokens: 318, output_tokens: 34 },
      },
      options
    );
    expect(decision).toEqual({ routeId: 2, usage: { inputTokens: 318, outputTokens: 34 } });
  });

  it("returns null routeId on unknown choice / malformed response", () => {
    expect(
      jevSystemoneAdapter.parseResponse(
        { answers: { route: { type: "choice", choice: "r9" } } },
        options
      ).routeId
    ).toBeNull();
    expect(jevSystemoneAdapter.parseResponse(null, options).routeId).toBeNull();
    expect(jevSystemoneAdapter.parseResponse({ answers: {} }, options).routeId).toBeNull();
  });
});

describe("chat adapter", () => {
  it("builds chat completion request with options in system prompt", () => {
    const req = chatAdapter.buildRequest(
      "gpt-4o-mini",
      { instruction: "inst", options, state: "[user] hi" },
      { model: "gpt-4o-mini", type: "chat" }
    );
    expect(req.path).toBe("/v1/chat/completions");
    const body = req.body as any;
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.stream).toBe(false);
    expect(body.messages[0].content).toContain("r1: gpt-4o-mini");
    expect(body.messages[1].content).toBe("[user] hi");
  });

  it("parses exact key and embedded key", () => {
    const mk = (content: string) => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    expect(chatAdapter.parseResponse(mk("r2"), options).routeId).toBe(2);
    expect(chatAdapter.parseResponse(mk('"r1"'), options).routeId).toBe(1);
    expect(chatAdapter.parseResponse(mk("I don't know"), options).routeId).toBeNull();
  });

  it("prefers the longest contained key (r1 is a prefix of r12)", () => {
    const prefixed: ClassifierRouteOption[] = [
      { key: "r1", routeId: 1, label: "cheap" },
      { key: "r12", routeId: 12, label: "premium" },
    ];
    const mk = (content: string) => ({ choices: [{ message: { content } }] });
    expect(chatAdapter.parseResponse(mk("r12"), prefixed).routeId).toBe(12);
    expect(chatAdapter.parseResponse(mk("I pick r12."), prefixed).routeId).toBe(12);
    expect(chatAdapter.parseResponse(mk("r1"), prefixed).routeId).toBe(1);
  });

  it("returns usage alongside the decision", () => {
    const mk = (content: string) => ({
      choices: [{ message: { content } }],
      usage: { prompt_tokens: 10, completion_tokens: 2 },
    });
    expect(chatAdapter.parseResponse(mk("r2"), options).usage).toEqual({
      inputTokens: 10,
      outputTokens: 2,
    });
  });
});

describe("summarize", () => {
  it("extracts messages per protocol, skipping system", () => {
    const openai = {
      messages: [
        { role: "system", content: "secret sys" },
        { role: "user", content: "hello" },
        { role: "assistant", content: [{ type: "text", text: "hi" }] },
      ],
    };
    expect(extractMessageTexts(openai, "openai")).toEqual([
      { role: "user", text: "hello" },
      { role: "assistant", text: "hi" },
    ]);
    const gemini = { contents: [{ role: "user", parts: [{ text: "g1" }] }] };
    expect(extractMessageTexts(gemini, "gemini")).toEqual([{ role: "user", text: "g1" }]);
    expect(extractMessageTexts(null, "openai")).toEqual([]);
  });

  it("fills budget greedily: first user anchor + newest first, respects budget", () => {
    const messages = [
      { role: "user", text: "a".repeat(100) },
      { role: "assistant", text: "b".repeat(100) },
      { role: "user", text: "c".repeat(100) },
    ];
    // 预算只够锚点 + 最后一条
    const summary = buildStateSummary(messages, 30); // 30 tok * 4 * 0.8 = 96 chars
    expect(summary).toContain("[user]");
    expect(summary.length).toBeLessThanOrEqual(96 + 16); // 允许格式开销的少量浮动
    // 锚点优先：首条 user 必在
    expect(summary.startsWith("[user] aaaa")).toBe(true);
  });

  it("truncates oversized single message instead of overflowing", () => {
    const messages = [{ role: "user", text: "x".repeat(10000) }];
    const summary = buildStateSummary(messages, 100); // 320 chars 预算
    expect(summary.length).toBeLessThan(400);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("returns empty for no messages or zero budget", () => {
    expect(buildStateSummary([], 100)).toBe("");
    expect(buildStateSummary([{ role: "user", text: "hi" }], 0)).toBe("");
  });

  it("estimateTokens is chars/4 ceiling", () => {
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});

describe("budget", () => {
  const data = {
    vivgrid: { id: "vivgrid", models: { jev: { id: "jev", cost: { input: 1, output: 1 }, limit: { context: 64000 } } } },
    openai: { id: "openai", models: { "gpt-4o": { id: "gpt-4o", cost: { input: 1, output: 1 }, limit: { context: 128000 } } } },
  } as any;

  it("finds context window by exact / last-segment match", () => {
    expect(lookupContextWindow("gpt-4o", data)).toBe(128000);
    expect(lookupContextWindow("typesafe/jev", data)).toBe(64000); // 末段匹配
    expect(lookupContextWindow("nonexistent", data)).toBeNull();
  });

  it("resolves budget: explicit > models.dev > default", () => {
    expect(resolveInputBudget(8192, 64000)).toBe(8192);
    expect(resolveInputBudget(undefined, 32000)).toBe(32000); // 低于 32k 封顶直通
    expect(resolveInputBudget(undefined, null)).toBe(4096);
  });

  it("caps models.dev-derived budget at 32k (large context windows)", () => {
    expect(resolveInputBudget(undefined, 1_000_000)).toBe(32768);
    expect(resolveInputBudget(undefined, 16384)).toBe(16384); // 低于封顶不抬高
    expect(resolveInputBudget(65536, 1_000_000)).toBe(65536); // 显式配置不受封顶限制
  });
});

describe("classifier_models entry parsing", () => {
  it("accepts valid entries, rejects invalid ones", () => {
    expect(isValidClassifierModelEntry({ model: "jev-latest", type: "jev-systemone" })).toBe(true);
    expect(
      isValidClassifierModelEntry({ model: "m", type: "chat", maxInputTokens: 8192, path: "/v1/x" })
    ).toBe(true);
    expect(isValidClassifierModelEntry({ model: "m", type: "nope" })).toBe(false);
    expect(isValidClassifierModelEntry({ model: "", type: "chat" })).toBe(false);
    expect(isValidClassifierModelEntry({ model: "m", type: "chat", maxInputTokens: 10 })).toBe(false);
    expect(isValidClassifierModelEntry({ model: "m", type: "chat", path: "https://evil.com/x" })).toBe(false);
    expect(isValidClassifierModelEntry({ model: "m", type: "chat", path: "/v1/../x" })).toBe(false);
    // URL 归一化等价逃逸写法（与 probe_config 同口径）
    expect(isValidClassifierModelEntry({ model: "m", type: "chat", path: "/%2e%2e/x" })).toBe(false);
    expect(isValidClassifierModelEntry({ model: "m", type: "chat", path: "/a/%2f/x" })).toBe(false);
    expect(isValidClassifierModelEntry({ model: "m", type: "chat", path: "/a\\x" })).toBe(false);
    expect(isValidClassifierModelEntry({ model: "m", type: "chat", path: "/a\tb" })).toBe(false);
    expect(isValidClassifierModelEntry({ model: "m", type: "chat", path: "/a?x=1" })).toBe(false);
  });

  it("parseClassifierModels tolerates garbage", () => {
    expect(parseClassifierModels(null)).toEqual([]);
    expect(parseClassifierModels("not json")).toEqual([]);
    expect(parseClassifierModels("{}")).toEqual([]);
    expect(
      parseClassifierModels(JSON.stringify([{ model: "jev-latest", type: "jev-systemone" }, { bad: 1 }]))
    ).toEqual([{ model: "jev-latest", type: "jev-systemone" }]);
  });
});

describe("runClassifier", () => {
  const fetchMock = vi.fn();
  beforeEach(() => vi.stubGlobal("fetch", fetchMock));
  afterEach(() => {
    vi.unstubAllGlobals();
    fetchMock.mockReset();
  });

  const upstream: UpstreamRoute = {
    id: 7,
    name: "typesafe",
    protocol: "openai",
    baseUrl: "https://api.typesafe.ai",
    priority: 0,
  };
  const routes = [
    { routeId: 1, targetModel: "gpt-4o-mini", description: "简单任务" },
    { routeId: 2, targetModel: "gpt-5", description: "复杂任务" },
  ];
  const deps = {
    resolveUpstreamKeys: vi.fn(async () => ["sk-cf-1"]),
    lookupContextWindow: vi.fn(async () => null),
  };

  it("posts to systemone with bearer auth and parses decision", async () => {
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          answers: { route: { type: "choice", choice: "r2" } },
          usage: { input_tokens: 100, output_tokens: 5 },
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      )
    );
    const result = await runClassifier({
      upstream,
      entry: { model: "jev-latest", type: "jev-systemone" },
      instruction: "选路由",
      routes,
      bodyJson: { messages: [{ role: "user", content: "写个编译器" }] },
      protocol: "openai",
      deps,
    });
    expect(result.routeId).toBe(2);
    expect(result.usage).toEqual({ inputTokens: 100, outputTokens: 5 });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.typesafe.ai/v1/systemone");
    expect(new Headers(init.headers).get("authorization")).toBe("Bearer sk-cf-1");
    expect(init.redirect).toBe("manual");
    const body = JSON.parse(init.body as string);
    expect(body.questions.route.criteria.r1).toBe("gpt-4o-mini — 简单任务");
    expect(body.state).toContain("写个编译器");
  });

  it("returns null routeId on non-2xx across all keys", async () => {
    fetchMock.mockResolvedValue(new Response("nope", { status: 500 }));
    const result = await runClassifier({
      upstream,
      entry: { model: "jev-latest", type: "jev-systemone" },
      instruction: "",
      routes,
      bodyJson: {},
      protocol: "openai",
      deps,
    });
    expect(result.routeId).toBeNull();
  });

  it("rejects chat type on non-openai upstream", async () => {
    const result = await runClassifier({
      upstream: { ...upstream, protocol: "anthropic" },
      entry: { model: "claude", type: "chat" },
      instruction: "",
      routes,
      bodyJson: {},
      protocol: "openai",
      deps,
    });
    expect(result.routeId).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("estimateOverheadTokens grows with options", () => {
    const small = estimateOverheadTokens("", []);
    const big = estimateOverheadTokens("x".repeat(400), options);
    expect(big).toBeGreaterThan(small);
  });
});
