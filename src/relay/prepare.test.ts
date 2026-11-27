// relay prepare：model / stream / 会话素材 / vkFp / headerNames / body 上限与读取顺序
import { describe, it, expect, afterEach } from "vitest";
import { prepare, RelayHttpError, rewriteBodyModel, stripQueryKey } from "./prepare";
import { computeSessionIdFromInput, extractSessionInput } from "@/lib/gateway/session";
import { virtualKeyFingerprint } from "@/lib/gateway/vk-fingerprint";

const ORIG_MAX = process.env.GATEWAY_MAX_BODY_MB;

afterEach(() => {
  if (ORIG_MAX === undefined) delete process.env.GATEWAY_MAX_BODY_MB;
  else process.env.GATEWAY_MAX_BODY_MB = ORIG_MAX;
});

function req(
  path: string,
  body: unknown,
  headers: Record<string, string> = {},
  method = "POST"
): Request {
  return new Request(`http://relay.local${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      authorization: "Bearer vk-test-key",
      "user-agent": "agent/1.0",
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function urlOf(path: string): URL {
  return new URL(`http://relay.local${path}`);
}

describe("prepare", () => {
  it("提取 model / stream / messages 与非空 body", async () => {
    const body = {
      model: "gpt-a",
      stream: true,
      messages: [{ role: "system", content: "sys" }, { role: "user", content: "hi" }],
    };
    const prepared = await prepare(req("/v1/chat/completions", body), urlOf("/v1/chat/completions"));
    expect(prepared.model).toBe("gpt-a");
    expect(prepared.stream).toBe(true);
    expect(prepared.hasMessages).toBe(true);
    expect(prepared.protocol).toBe("openai");
    expect(prepared.estimatedInputTokens).toBeGreaterThan(0);
  });

  it("sessionInput 与直连指纹素材逐字节相等（不含 tail）", async () => {
    const body = {
      model: "gpt-a",
      messages: [
        { role: "system", content: "S".repeat(50) },
        { role: "user", content: "hello" },
      ],
    };
    const prepared = await prepare(req("/v1/chat/completions", body), urlOf("/v1/chat/completions"));
    const expected = extractSessionInput(body, "gpt-a", 0, "openai");
    const suffix = computeSessionIdFromInput("", "gpt-a", 0, "openai");
    expect(prepared.sessionInput).toBe(expected.slice(0, expected.length - suffix.length));
    expect(prepared.sessionInput).toBe(`${"S".repeat(50)}hello`);
  });

  it("原生 session header 命中时不传 sessionInput（只传原生值，截断 256）", async () => {
    const body = { model: "gpt-a", messages: [{ role: "user", content: "hi" }] };
    const prepared = await prepare(
      req("/v1/chat/completions", body, { "x-claude-code-session-id": `  ${"n".repeat(300)}  ` }),
      urlOf("/v1/chat/completions")
    );
    expect(prepared.sessionInput).toBeNull();
    expect(prepared.nativeSessionId).toHaveLength(256);
  });

  it("vkFp 只从 header 取（query 不参与认证），headerNames 小写化", async () => {
    const prepared = await prepare(
      req("/v1/chat/completions?key=vk-in-query", { model: "gpt-a" }, { "X-Custom": "1" }),
      urlOf("/v1/chat/completions?key=vk-in-query")
    );
    expect(prepared.vkFp).toBe(virtualKeyFingerprint("vk-test-key"));
    expect(prepared.headerNames).toContain("x-custom");
    // query 里的 key 已剥（不透给上游）
    expect(prepared.path).not.toContain("key=");
  });

  it("GET models：不读 body、model 为 null", async () => {
    const prepared = await prepare(req("/v1/models", undefined, {}, "GET"), urlOf("/v1/models"));
    expect(prepared.model).toBeNull();
    expect(prepared.bodyBuffer.length).toBe(0);
    expect(prepared.vkFp).toBe(virtualKeyFingerprint("vk-test-key"));
  });

  it("content-length 超限直接 413（不读 body）", async () => {
    process.env.GATEWAY_MAX_BODY_MB = "0.001"; // ≈1KB
    const big = { model: "gpt-a", messages: [{ role: "user", content: "x".repeat(4000) }] };
    await expect(
      prepare(req("/v1/chat/completions", big), urlOf("/v1/chat/completions"))
    ).rejects.toBeInstanceOf(RelayHttpError);
  });

  it("坏 JSON → 400", async () => {
    const bad = new Request("http://relay.local/v1/chat/completions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not json",
    });
    await expect(prepare(bad, urlOf("/v1/chat/completions"))).rejects.toMatchObject({ status: 400 });
  });
});

describe("rewriteBodyModel", () => {
  it("按 hop 的真实 model 改写 body；gemini 不动 body（path 已烘进 URL）", async () => {
    const body = { model: "my-route", messages: [{ role: "user", content: "hi" }] };
    const prepared = await prepare(req("/v1/chat/completions", body), urlOf("/v1/chat/completions"));
    const rewritten = rewriteBodyModel(prepared, "gpt-real");
    expect(JSON.parse(new TextDecoder().decode(rewritten)).model).toBe("gpt-real");
    // 原始 buffer 不被改动（同一 prepared 供多个 hop 复用）
    expect(JSON.parse(new TextDecoder().decode(prepared.bodyBuffer)).model).toBe("my-route");

    const geminiPrepared = {
      ...prepared,
      protocol: "gemini" as const,
      bodyBuffer: new TextEncoder().encode(JSON.stringify({ contents: [] })),
    };
    expect(rewriteBodyModel(geminiPrepared, "gemini-real")).toBe(geminiPrepared.bodyBuffer);
  });
});

describe("stripQueryKey", () => {
  it("剥掉 key 参数，其余 query 保留", () => {
    expect(stripQueryKey("/v1/chat/completions?alt=sse&key=vk-x")).toBe(
      "/v1/chat/completions?alt=sse"
    );
    expect(stripQueryKey("/v1/chat/completions?key=vk-x")).toBe("/v1/chat/completions");
    expect(stripQueryKey("/v1/models")).toBe("/v1/models");
  });
});
