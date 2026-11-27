import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createFakeUpstream } from "./server";
import type { FakeUpstream, FakeUpstreamConfig } from "./types";

const config: FakeUpstreamConfig = {
  models: {
    "gpt-a": { protocol: "openai", promptTokens: 12, completionTokens: 8, cachedTokens: 5 },
    "gpt-b": { protocol: "openai", promptTokens: 3, completionTokens: 2 },
    "claude-a": { protocol: "anthropic", promptTokens: 24, completionTokens: 11, cachedTokens: 64 },
    "gemini-a": { protocol: "gemini", promptTokens: 18, completionTokens: 9 },
    "resp-a": { protocol: "responses" },
  },
  keys: [
    { key: "sk-openai", protocols: ["openai", "responses"] },
    { key: "sk-anthropic", protocols: ["anthropic"] },
    { key: "sk-gemini", protocols: ["gemini"] },
    { key: "sk-limited", models: ["gpt-a"] },
    { key: "sk-dead", fail: { status: 401, message: "invalid api key" } },
    { key: "sk-flaky", failFirst: { status: 503, message: "temporarily overloaded" } },
  ],
};

let upstream: FakeUpstream;

beforeAll(async () => {
  upstream = await createFakeUpstream(config);
});

afterAll(async () => {
  await upstream.close();
});

beforeEach(() => {
  upstream.reset();
});

function post(path: string, key: string | null, body: unknown, headers: Record<string, string> = {}) {
  return fetch(`${upstream.url}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(key === null ? {} : { authorization: `Bearer ${key}` }),
      ...headers,
    },
    body: JSON.stringify(body),
  });
}

async function sseText(res: Response): Promise<string> {
  return await res.text();
}

describe("fake upstream: openai", () => {
  it("非流式：usage 含 cache 明细，请求被记录", async () => {
    const res = await post("/v1/chat/completions", "sk-openai", {
      model: "gpt-a",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("chat.completion");
    expect(body.model).toBe("gpt-a");
    expect(body.choices[0].message.content).toBe("fake upstream ok");
    expect(body.usage).toEqual({
      prompt_tokens: 12,
      completion_tokens: 8,
      total_tokens: 20,
      prompt_tokens_details: { cached_tokens: 5 },
    });
    expect(upstream.requests).toHaveLength(1);
    expect(upstream.requests[0]).toMatchObject({
      protocol: "openai",
      key: "sk-openai",
      model: "gpt-a",
      stream: false,
      status: 200,
    });
  });

  it("流式：SSE 帧 + [DONE]，末帧带 usage", async () => {
    const res = await post("/v1/chat/completions", "sk-openai", { model: "gpt-a", stream: true, messages: [] });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await sseText(res);
    expect(text).toContain('"object":"chat.completion.chunk"');
    expect(text).toContain("fake upstream ok");
    expect(text).toContain('"finish_reason":"stop"');
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);
    expect(text).toContain('"prompt_tokens":12');
  });

  it("bad key → 401（openai 错误形状 + invalid_api_key）", async () => {
    const res = await post("/v1/chat/completions", "sk-dead", { model: "gpt-a", messages: [] });
    expect(res.status).toBe(401);
    const body = (await res.json()) as any;
    expect(body.error.type).toBe("invalid_request_error");
    expect(body.error.code).toBe("invalid_api_key");
  });

  it("未配置的 model → 404 model_not_found", async () => {
    const res = await post("/v1/chat/completions", "sk-openai", { model: "nope", messages: [] });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.code).toBe("model_not_found");
  });

  it("key 的 model 白名单 → 403", async () => {
    const ok = await post("/v1/chat/completions", "sk-limited", { model: "gpt-a", messages: [] });
    expect(ok.status).toBe(200);
    const denied = await post("/v1/chat/completions", "sk-limited", { model: "gpt-b", messages: [] });
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as any).error.code).toBe("permission_denied");
  });

  it("key 的协议白名单 → 403（openai key 打 anthropic 端点）", async () => {
    const res = await fetch(`${upstream.url}/v1/messages`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": "sk-openai" },
      body: JSON.stringify({ model: "claude-a", messages: [] }),
    });
    expect(res.status).toBe(403);
  });

  it("model 声明协议与端点不符 → 404（防配错）", async () => {
    const res = await post("/v1/chat/completions", "sk-openai", { model: "claude-a", messages: [] });
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.message).toContain("served as anthropic");
  });
});

describe("fake upstream: failover 语义", () => {
  it("failFirst：第一次 503，第二次成功", async () => {
    const first = await post("/v1/chat/completions", "sk-flaky", { model: "gpt-a", messages: [] });
    expect(first.status).toBe(503);
    const second = await post("/v1/chat/completions", "sk-flaky", { model: "gpt-a", messages: [] });
    expect(second.status).toBe(200);
    expect(upstream.requests.map((r) => r.status)).toEqual([503, 200]);
  });

  it("reset() 清空日志与失败计数", async () => {
    await post("/v1/chat/completions", "sk-flaky", { model: "gpt-a", messages: [] });
    upstream.reset();
    expect(upstream.requests).toHaveLength(0);
    const res = await post("/v1/chat/completions", "sk-flaky", { model: "gpt-a", messages: [] });
    expect(res.status).toBe(503);
  });

  it("未配置 keys 时不校验 key（auth disabled）", async () => {
    const open = await createFakeUpstream({ keys: [], models: { "gpt-x": { protocol: "openai" } } });
    try {
      const res = await fetch(`${open.url}/v1/chat/completions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "gpt-x", messages: [] }),
      });
      expect(res.status).toBe(200);
    } finally {
      await open.close();
    }
  });
});

describe("fake upstream: anthropic", () => {
  const headers = { "x-api-key": "sk-anthropic", "anthropic-version": "2023-06-01" };

  it("非流式：content 数组 + cache_read_input_tokens", async () => {
    const res = await post("/v1/messages", null, { model: "claude-a", max_tokens: 32, messages: [] }, headers);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.type).toBe("message");
    expect(body.content).toEqual([{ type: "text", text: "fake upstream ok" }]);
    expect(body.usage).toEqual({ input_tokens: 24, output_tokens: 11, cache_read_input_tokens: 64 });
    expect(body.stop_reason).toBe("end_turn");
  });

  it("流式：事件名齐全且顺序正确", async () => {
    const res = await post("/v1/messages", null, { model: "claude-a", stream: true, messages: [] }, headers);
    const text = await sseText(res);
    const events = [...text.matchAll(/^event: (.+)$/gm)].map((m) => m[1]);
    expect(events).toEqual([
      "message_start",
      "content_block_start",
      "content_block_delta",
      "content_block_stop",
      "message_delta",
      "message_stop",
    ]);
    expect(text).toContain('"cache_read_input_tokens"'); // message_start 的 usage 里没有 cache 字段
  });

  it("缺失 key → 401 authentication_error", async () => {
    const res = await post("/v1/messages", null, { model: "claude-a", messages: [] });
    expect(res.status).toBe(401);
    expect(((await res.json()) as any).error.type).toBe("authentication_error");
  });
});

describe("fake upstream: gemini", () => {
  const key = { "x-goog-api-key": "sk-gemini" };

  it("非流式：candidates + usageMetadata", async () => {
    const res = await post("/v1beta/models/gemini-a:generateContent", null, {
      contents: [{ parts: [{ text: "hi" }] }],
    }, key);
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.candidates[0].content.parts[0].text).toBe("fake upstream ok");
    expect(body.usageMetadata).toEqual({
      promptTokenCount: 18,
      candidatesTokenCount: 9,
      totalTokenCount: 27,
    });
    expect(upstream.requests[0]).toMatchObject({ protocol: "gemini", key: "sk-gemini", model: "gemini-a" });
  });

  it("streamGenerateContent：两帧 SSE，末帧带 usageMetadata", async () => {
    const res = await post("/v1beta/models/gemini-a:streamGenerateContent?alt=sse", null, {
      contents: [],
    }, key);
    expect(res.status).toBe(200);
    const text = await sseText(res);
    const frames = text
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => JSON.parse(f.slice("data: ".length)) as any);
    expect(frames).toHaveLength(2);
    expect(frames[0].candidates[0].content.parts[0].text).toBe("fake upstream ok");
    expect(frames[1].candidates[0].finishReason).toBe("STOP");
    expect(frames[1].usageMetadata.totalTokenCount).toBe(27);
  });

  it("?key= 也接受（gemini 的 query 认证形态）；未知 model → 404", async () => {
    const ok = await post("/v1beta/models/gemini-a:generateContent?key=sk-gemini", null, { contents: [] });
    expect(ok.status).toBe(200);
    const missing = await post("/v1beta/models/unknown:generateContent", null, { contents: [] }, key);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as any).error.status).toBe("NOT_FOUND");
  });
});

describe("fake upstream: responses / models 列表 / 未知路径", () => {
  it("responses：output_text + input_tokens_details", async () => {
    const res = await post("/v1/responses", "sk-openai", { model: "resp-a", input: "hi" });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.object).toBe("response");
    expect(body.output[0].content[0]).toEqual({ type: "output_text", text: "fake upstream ok", annotations: [] });
    expect(body.usage.input_tokens_details).toEqual({ cached_tokens: 0 });
  });

  it("GET /v1/models 按 key 白名单过滤，协议按鉴权头区分", async () => {
    const openai = (await (await fetch(`${upstream.url}/v1/models`, { headers: { authorization: "Bearer sk-openai" } })).json()) as any;
    expect(openai.object).toBe("list");
    expect(openai.data.map((m: any) => m.id).sort()).toEqual(["gpt-a", "gpt-b"]);

    const anthropic = (await (await fetch(`${upstream.url}/v1/models`, { headers: { "x-api-key": "sk-anthropic" } })).json()) as any;
    expect(anthropic.data.map((m: any) => m.id)).toEqual(["claude-a"]);

    const limited = (await (await fetch(`${upstream.url}/v1/models`, { headers: { authorization: "Bearer sk-limited" } })).json()) as any;
    expect(limited.data.map((m: any) => m.id)).toEqual(["gpt-a"]);

    const gemini = (await (await fetch(`${upstream.url}/v1beta/models`, { headers: { "x-goog-api-key": "sk-gemini" } })).json()) as any;
    expect(gemini.models[0].name).toBe("models/gemini-a");
    expect(gemini.models[0].supportedGenerationMethods).toContain("generateContent");
  });

  it("未知路径 → 404，且不计入 protocol 统计", async () => {
    const res = await fetch(`${upstream.url}/v1/embeddings`, { method: "POST", body: "{}" });
    expect(res.status).toBe(404);
    expect(upstream.requests).toHaveLength(0);
  });

  it("__fake/requests 与 __fake/reset 控制面可用（独立进程场景）", async () => {
    await post("/v1/chat/completions", "sk-openai", { model: "gpt-a", messages: [] });
    const listed = (await (await fetch(`${upstream.url}/__fake/requests`)).json()) as any;
    expect(listed.requests).toHaveLength(1);
    await fetch(`${upstream.url}/__fake/reset`, { method: "POST" });
    expect(upstream.requests).toHaveLength(0);
  });
});
