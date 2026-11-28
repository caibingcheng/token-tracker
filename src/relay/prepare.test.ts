// relay prepare：model / stream / 会话素材 / vkFp / headerNames / body 上限与读取顺序
import { describe, it, expect, afterEach } from "vitest";
import { prepare, ensureIncludeUsage, RelayHttpError, rewriteBodyModel, stripQueryKey } from "./prepare";
import { computeSessionId, extractSessionInput } from "@/lib/gateway/session";
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

  it("会话指纹在 relay 本地算（隔离项用 vk 指纹），不再上送 system/首条 user 明文", async () => {
    const body = {
      model: "gpt-a",
      messages: [
        { role: "system", content: "S".repeat(50) },
        { role: "user", content: "hello" },
      ],
    };
    const prepared = await prepare(req("/v1/chat/completions", body), urlOf("/v1/chat/completions"));
    const vkFp = virtualKeyFingerprint("vk-test-key");
    expect(prepared.sessionFingerprint).toBe(
      computeSessionId(extractSessionInput(body, "gpt-a", vkFp, "openai"))
    );
    // 指纹稳定：同会话两次请求 → 同值
    const again = await prepare(req("/v1/chat/completions", body), urlOf("/v1/chat/completions"));
    expect(again.sessionFingerprint).toBe(prepared.sessionFingerprint);
    // PreparedRequest 里已不再携带明文素材
    expect(Object.keys(prepared)).not.toContain("sessionInput");
  });

  it("原生 session header 命中时不传指纹（只传原生值，截断 256）", async () => {
    const body = { model: "gpt-a", messages: [{ role: "user", content: "hi" }] };
    const prepared = await prepare(
      req("/v1/chat/completions", body, { "x-claude-code-session-id": `  ${"n".repeat(300)}  ` }),
      urlOf("/v1/chat/completions")
    );
    expect(prepared.sessionFingerprint).toBeNull();
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

describe("ensureIncludeUsage（由 plan 指令触发的 body 改写）", () => {
  it("无 stream_options → 注入 include_usage", async () => {
    const body = { model: "gpt-a", stream: true, messages: [{ role: "user", content: "hi" }] };
    const prepared = await prepare(req("/v1/chat/completions", body), urlOf("/v1/chat/completions"));
    const injected = ensureIncludeUsage(prepared);
    const sent = JSON.parse(new TextDecoder().decode(injected.bodyBuffer));
    expect(sent.stream_options).toEqual({ include_usage: true });
    // model / messages 不被破坏（hop 改写与上游语义都依赖它们）
    expect(sent.model).toBe("gpt-a");
    expect(sent.messages).toHaveLength(1);
    // 幂等：再调一次不再变
    expect(ensureIncludeUsage(injected)).toBe(injected);
  });

  it("显式 include_usage: false 保留不动（不静默修正客户端请求，返回原对象）", async () => {
    const body = {
      model: "gpt-a",
      stream: true,
      stream_options: { include_usage: false },
      messages: [{ role: "user", content: "hi" }],
    };
    const prepared = await prepare(req("/v1/chat/completions", body), urlOf("/v1/chat/completions"));
    expect(ensureIncludeUsage(prepared)).toBe(prepared);
    expect(JSON.parse(new TextDecoder().decode(prepared.bodyBuffer)).stream_options).toEqual({
      include_usage: false,
    });
  });

  it("既有 stream_options 缺 include_usage → 补上并保留其余键", async () => {
    const body = {
      model: "gpt-a",
      stream: true,
      stream_options: { foo: 1 },
      messages: [{ role: "user", content: "hi" }],
    };
    const prepared = await prepare(req("/v1/chat/completions", body), urlOf("/v1/chat/completions"));
    const injected = ensureIncludeUsage(prepared);
    expect(JSON.parse(new TextDecoder().decode(injected.bodyBuffer)).stream_options).toEqual({
      foo: 1,
      include_usage: true,
    });
  });

  it(">1MB scan 路径：追加到根 } 前，model span 不受影响", async () => {
    const body = {
      model: "gpt-a",
      stream: true,
      messages: [{ role: "user", content: "x".repeat(1100 * 1024) }],
    };
    const prepared = await prepare(req("/v1/chat/completions", body), urlOf("/v1/chat/completions"));
    expect(prepared.bodyScan).not.toBeNull();
    const injected = ensureIncludeUsage(prepared);
    const sent = JSON.parse(new TextDecoder().decode(injected.bodyBuffer));
    expect(sent.stream_options).toEqual({ include_usage: true });
    // 注入在末尾，既有键区间未偏移：hop 改写仍能准确定位 model
    const rewritten = JSON.parse(new TextDecoder().decode(rewriteBodyModel(injected, "gpt-real")));
    expect(rewritten.model).toBe("gpt-real");
    expect(rewritten.stream_options).toEqual({ include_usage: true });
    expect(rewritten.messages).toHaveLength(1);
  });
});

describe("/raw 裸透传", () => {
  it("协议检测在内层 path 上做（anthropic / gemini 不能被当成 openai）", async () => {
    const anthropic = await prepare(
      req("/raw/v1/messages", { model: "claude-a", messages: [] }),
      urlOf("/raw/v1/messages")
    );
    expect(anthropic.protocol).toBe("anthropic");
    expect(anthropic.model).toBe("claude-a");

    const gemini = await prepare(
      req("/raw/v1beta/models/gemini-2.5-pro:generateContent", {
        contents: [{ role: "user", parts: [{ text: "hi" }] }],
      }),
      urlOf("/raw/v1beta/models/gemini-2.5-pro:generateContent")
    );
    expect(gemini.protocol).toBe("gemini");
    expect(gemini.model).toBe("gemini-2.5-pro");
    // path 字段保持原样（剥前缘是中心 plan 的事，两条链 URL 拼接同口径）
    expect(gemini.path).toContain("/raw/v1beta/");
  });

  it("内层 path 逃逸（..）在 URL 层已归一化，走不到剥前缀（留注释防误加）", async () => {
    // `new URL()` 会把 ../ 与 %2e%2e 一并归一，url.pathname 已不含 /raw。
    // 真正的逃逸拦截在中心 plan（sanitizePathSegments + %2f 拒绝），这里只验证行为不惊。
    const prepared = await prepare(
      req("/raw/v1/%2e%2e/%2e%2e/etc/passwd", { model: "gpt-a" }),
      urlOf("/raw/v1/%2e%2e/%2e%2e/etc/passwd")
    );
    expect(prepared.path).toBe("/etc/passwd");
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
