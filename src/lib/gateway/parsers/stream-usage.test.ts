import { describe, it, expect } from "vitest";
import {
  parseOpenAiStreaming,
  parseAnthropicStreaming,
  parseGeminiStreaming,
} from "./index";
import { StreamUsageExtractor } from "./stream-usage";
import type { Protocol } from "../model-router";

const OPENAI_SSE = [
  'data: {"id":"1","choices":[{"delta":{"role":"assistant"}}]}',
  "",
  'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}',
  "",
  'data: {"id":"1","choices":[{"delta":{"content":" there"}}]}',
  "",
  'data: {"id":"1","choices":[],"usage":{"prompt_tokens":200,"completion_tokens":80,"prompt_tokens_details":{"cached_tokens":120}}}',
  "",
  "data: [DONE]",
  "",
].join("\n");

const ANTHROPIC_SSE = [
  'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":250,"cache_read_input_tokens":60,"cache_creation_input_tokens":25}}}',
  "",
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
  "",
  'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":" world"}}',
  "",
  'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":77}}',
  "",
  'event: message_stop\ndata: {"type":"message_stop"}',
  "",
].join("\n");

const GEMINI_SSE = [
  'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}',
  "",
  'data: {"candidates":[{"content":{"parts":[{"text":"b"}]}}]}',
  "",
  'data: {"candidates":[{"content":{"parts":[{"text":"c"}]}}],"usageMetadata":{"promptTokenCount":500,"candidatesTokenCount":150,"cachedContentTokenCount":300}}',
  "",
].join("\n");

const RESPONSES_SSE = [
  'data: {"type":"response.created","response":{"id":"resp_1"}}',
  "",
  'data: {"type":"response.output_text.delta","delta":"hi"}',
  "",
  'data: {"type":"response.output_text.delta","delta":" there"}',
  "",
  'data: {"type":"response.completed","response":{"id":"resp_1","usage":{"input_tokens":200,"output_tokens":80,"input_tokens_details":{"cached_tokens":120,"cache_write_tokens":15}}}}',
  "",
].join("\n");

// 以固定小步长切分，模拟网络 chunk 边界落在任意位置（含多字节字符中间）
function splitIntoChunks(text: string, chunkSize: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text);
  const chunks: Uint8Array[] = [];
  for (let i = 0; i < bytes.length; i += chunkSize) {
    chunks.push(bytes.slice(i, i + chunkSize));
  }
  return chunks;
}

function extractIncrementally(sse: string, protocol: Protocol, chunkSize: number) {
  const extractor = new StreamUsageExtractor(protocol);
  for (const chunk of splitIntoChunks(sse, chunkSize)) {
    extractor.feed(chunk);
  }
  return extractor.finish();
}

describe.each([
  { name: "OpenAI", protocol: "openai" as Protocol, sse: OPENAI_SSE, expected: parseOpenAiStreaming(OPENAI_SSE) },
  { name: "Responses API", protocol: "openai" as Protocol, sse: RESPONSES_SSE, expected: parseOpenAiStreaming(RESPONSES_SSE) },
  { name: "Anthropic", protocol: "anthropic" as Protocol, sse: ANTHROPIC_SSE, expected: parseAnthropicStreaming(ANTHROPIC_SSE) },
  { name: "Gemini", protocol: "gemini" as Protocol, sse: GEMINI_SSE, expected: parseGeminiStreaming(GEMINI_SSE) },
])("$name incremental extractor", ({ protocol, sse, expected }) => {
  it("matches batch parser on whole input", () => {
    const extractor = new StreamUsageExtractor(protocol);
    extractor.feed(new TextEncoder().encode(sse));
    expect(extractor.finish()).toEqual(expected);
  });

  it.each([1, 2, 3, 5, 7, 13])("matches batch parser at every chunk boundary (chunk=%i)", (chunkSize) => {
    expect(extractIncrementally(sse, protocol, chunkSize)).toEqual(expected);
  });
});

describe("StreamUsageExtractor edge cases", () => {
  it("OpenAI returns null when no usage chunk", () => {
    const sse = 'data: {"id":"1","choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n';
    expect(extractIncrementally(sse, "openai", 1)).toBeNull();
  });

  it("Anthropic returns null when no usage events", () => {
    const sse = 'data: {"type":"message_stop"}\n\n';
    expect(extractIncrementally(sse, "anthropic", 1)).toBeNull();
  });

  it("Gemini returns null without usageMetadata", () => {
    const sse = 'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}\n\n';
    expect(extractIncrementally(sse, "gemini", 1)).toBeNull();
  });

  it("returns null on empty input", () => {
    expect(extractIncrementally("", "openai", 4)).toBeNull();
  });

  it("handles multi-line data events split across chunks", () => {
    const sse = 'data: {"a":1}\ndata: {"b":2}\n\ndata: {"c":3}\n\n';
    const extractor = new StreamUsageExtractor("openai");
    for (const chunk of splitIntoChunks(sse, 3)) extractor.feed(chunk);
    // 无 usage 字段 → null（不抛错即可）
    expect(extractor.finish()).toBeNull();
  });

  it("skips events whose content mentions usage but lacks usage field", () => {
    // content 文本包含 "usage" 字样，但无 usage 字段 → 不应误判为有 usage
    const sse = 'data: {"id":"1","choices":[{"delta":{"content":"the word usage appears here"}}]}\n\n';
    const extractor = new StreamUsageExtractor("openai");
    extractor.feed(new TextEncoder().encode(sse));
    expect(extractor.finish()).toBeNull();
  });

  it("ignores trailing partial event without terminating blank line", () => {
    const sse = 'data: {"id":"1","choices":[],"usage":{"prompt_tokens":5,"completion_tokens":2}}';
    const extractor = new StreamUsageExtractor("openai");
    extractor.feed(new TextEncoder().encode(sse));
    const result = extractor.finish();
    expect(result).toEqual({ inputTokens: 5, outputTokens: 2, cacheRead: 0, cacheWrite: 0, hasUsage: true });
  });

  it("finish is idempotent (no double-processing after first call)", () => {
    const extractor = new StreamUsageExtractor("openai");
    extractor.feed(new TextEncoder().encode(OPENAI_SSE));
    expect(extractor.finish()).toEqual({ inputTokens: 80, outputTokens: 80, cacheRead: 120, cacheWrite: 0, hasUsage: true });
    expect(extractor.finish()).toBeNull();
    // finish 后 feed 不再生效
    extractor.feed(new TextEncoder().encode('data: {"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n'));
    expect(extractor.finish()).toBeNull();
  });

  it("Anthropic last message_delta output wins", () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      "",
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":3}}',
      "",
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":9}}',
      "",
    ].join("\n");
    const result = extractIncrementally(sse, "anthropic", 2);
    expect(result).toEqual({ inputTokens: 10, outputTokens: 9, cacheRead: 0, cacheWrite: 0, hasUsage: true });
  });

  it("handles multi-byte UTF-8 characters split across chunk boundaries", () => {
    const sse = 'data: {"id":"1","choices":[{"delta":{"content":"你好世界"}}]}\n\ndata: {"id":"1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n';
    const result = extractIncrementally(sse, "openai", 3);
    expect(result).toEqual({ inputTokens: 10, outputTokens: 5, cacheRead: 0, cacheWrite: 0, hasUsage: true });
  });
});
