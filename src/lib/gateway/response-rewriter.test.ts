import { describe, it, expect } from "vitest";
import { rewriteModelNonStreaming, createSseModelRewriter } from "./response-rewriter";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function through(
  rewriter: ReturnType<typeof createSseModelRewriter>,
  chunks: string[]
): string {
  let out = "";
  for (const chunk of chunks) {
    out += decoder.decode(rewriter.transform(encoder.encode(chunk)));
  }
  out += decoder.decode(rewriter.flush());
  return out;
}

describe("rewriteModelNonStreaming", () => {
  it("rewrites top-level model for openai", () => {
    const input = JSON.stringify({ id: "x", model: "gpt-4o-real", choices: [] });
    const out = rewriteModelNonStreaming(input, "openai", "my-alias");
    expect(JSON.parse(out).model).toBe("my-alias");
    expect(JSON.parse(out).id).toBe("x");
  });

  it("rewrites top-level model for anthropic", () => {
    const input = JSON.stringify({ type: "message", model: "claude-real", content: [] });
    const out = rewriteModelNonStreaming(input, "anthropic", "my-claude");
    expect(JSON.parse(out).model).toBe("my-claude");
  });

  it("returns original text when JSON parse fails", () => {
    const input = "not-json{{";
    expect(rewriteModelNonStreaming(input, "openai", "alias")).toBe(input);
  });

  it("returns original text when no top-level model field", () => {
    const input = JSON.stringify({ foo: "bar" });
    expect(rewriteModelNonStreaming(input, "openai", "alias")).toBe(input);
  });

  it("does not rewrite gemini (modelVersion preserved)", () => {
    const input = JSON.stringify({ modelVersion: "gemini-1.5-flash-001", candidates: [] });
    expect(rewriteModelNonStreaming(input, "gemini", "alias")).toBe(input);
  });
});

describe("createSseModelRewriter - openai", () => {
  it("rewrites top-level model in each chunk", () => {
    const sse =
      'data: {"id":"1","model":"gpt-4o-real","choices":[{"delta":{"content":"hi"}}]}\n\n' +
      'data: {"id":"1","model":"gpt-4o-real","choices":[]}\n\n' +
      "data: [DONE]\n\n";
    const out = through(createSseModelRewriter("openai", "my-alias"), [sse]);
    expect(out).toContain('"model":"my-alias"');
    expect(out).not.toContain("gpt-4o-real");
    expect(out).toContain("data: [DONE]");
  });

  it("handles events split across chunks", () => {
    const full =
      'data: {"id":"1","model":"gpt-4o-real","choices":[{"delta":{"content":"hi"}}]}\n\n' +
      "data: [DONE]\n\n";
    // 事件一半在上个 chunk：第一个 chunk 只含事件前半
    const mid = full.indexOf('"choices"');
    const rewriter = createSseModelRewriter("openai", "my-alias");
    const first = decoder.decode(rewriter.transform(encoder.encode(full.slice(0, mid))));
    const second = decoder.decode(rewriter.transform(encoder.encode(full.slice(mid))));
    expect(first).toBe(""); // 事件不完整，先缓冲
    expect(second).toContain('"model":"my-alias"');
    expect(second).toContain("data: [DONE]");
  });

  it("passes through [DONE], comment lines and event lines untouched", () => {
    const sse =
      ": ping comment\n\n" +
      'event: foo\n' +
      'data: {"model":"gpt-4o-real"}\n\n' +
      "data: [DONE]\n\n";
    const out = through(createSseModelRewriter("openai", "my-alias"), [sse]);
    expect(out).toContain(": ping comment\n\n");
    expect(out).toContain("event: foo\n");
    expect(out).toContain('data: {"model":"my-alias"}');
    expect(out).toContain("data: [DONE]");
  });

  it("merges multi-line data events and rewrites", () => {
    const sse =
      'data: {"id":"1",\n' +
      'data: "model":"gpt-4o-real",\n' +
      'data: "choices":[]}\n\n';
    const out = through(createSseModelRewriter("openai", "my-alias"), [sse]);
    expect(out).toContain('"model":"my-alias"');
    expect(out).not.toContain("gpt-4o-real");
  });

  it("passes through corrupted JSON events untouched", () => {
    const sse = "data: {broken json\n\n" + "data: [DONE]\n\n";
    const out = through(createSseModelRewriter("openai", "my-alias"), [sse]);
    expect(out).toContain("data: {broken json\n\n");
  });

  it("handles CRLF line endings", () => {
    const sse = 'data: {"model":"gpt-4o-real"}\r\n\r\n';
    const out = through(createSseModelRewriter("openai", "my-alias"), [sse]);
    expect(out).toContain('"model":"my-alias"');
    expect(out).toContain("\r\n\r\n");
  });

  it("flushes residual buffer at stream end", () => {
    const rewriter = createSseModelRewriter("openai", "my-alias");
    const partial = decoder.decode(rewriter.transform(encoder.encode('data: {"model"')));
    expect(partial).toBe(""); // 无完整事件
    const flushed = decoder.decode(rewriter.flush());
    expect(flushed).toBe('data: {"model"');
  });
});

describe("createSseModelRewriter - anthropic", () => {
  it("rewrites message.model in message_start only", () => {
    const sse =
      'event: message_start\n' +
      'data: {"type":"message_start","message":{"id":"m1","model":"claude-real","content":[]}}\n\n' +
      'event: content_block_delta\n' +
      'data: {"type":"content_block_delta","delta":{"text":"hi"}}\n\n' +
      'event: message_stop\n' +
      'data: {"type":"message_stop"}\n\n';
    const out = through(createSseModelRewriter("anthropic", "my-claude"), [sse]);
    expect(out).toContain('"model":"my-claude"');
    expect(out).not.toContain("claude-real");
    // 非 message_start 事件原样透传
    expect(out).toContain('"delta":{"text":"hi"}');
    expect(out).toContain('event: message_stop');
  });

  it("passes through message_start without model untouched", () => {
    const sse = 'data: {"type":"message_start","message":{"id":"m1"}}\n\n';
    const out = through(createSseModelRewriter("anthropic", "my-claude"), [sse]);
    expect(out).toContain('"message":{"id":"m1"}');
  });
});

describe("createSseModelRewriter - gemini", () => {
  it("is identity (modelVersion preserved)", () => {
    const sse = 'data: {"candidates":[],"modelVersion":"gemini-1.5-flash-001"}\n\n';
    const rewriter = createSseModelRewriter("gemini", "alias");
    expect(rewriter.transform(encoder.encode(sse))).toEqual(encoder.encode(sse));
  });
});
