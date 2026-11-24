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

describe("StreamUsageExtractor sawTerminal", () => {
  function feedAll(sse: string, protocol: Protocol) {
    const extractor = new StreamUsageExtractor(protocol);
    for (const chunk of splitIntoChunks(sse, 3)) extractor.feed(chunk);
    // 与 proxy 的 onDone 一致：finish 处理尾部残余事件
    extractor.finish();
    return extractor;
  }

  it("OpenAI chat: set on [DONE]", () => {
    expect(feedAll(OPENAI_SSE, "openai").sawTerminal).toBe(true);
  });

  it("OpenAI chat: not set when stream ends without [DONE]", () => {
    const sse = 'data: {"id":"1","choices":[],"usage":{"prompt_tokens":1,"completion_tokens":1}}\n\n';
    expect(feedAll(sse, "openai").sawTerminal).toBe(false);
  });

  it("Responses API: set on response.completed", () => {
    expect(feedAll(RESPONSES_SSE, "openai").sawTerminal).toBe(true);
  });

  it("Anthropic: set on message_stop", () => {
    expect(feedAll(ANTHROPIC_SSE, "anthropic").sawTerminal).toBe(true);
  });

  it("not fooled by content text mentioning terminal events", () => {
    const sse =
      'data: {"id":"1","choices":[{"delta":{"content":"the type response.completed and \\"message_stop\\" appear here"}}]}\n\n';
    expect(feedAll(sse, "openai").sawTerminal).toBe(false);
  });

  it("Gemini: never set (no terminal event in protocol)", () => {
    expect(feedAll(GEMINI_SSE, "gemini").sawTerminal).toBe(false);
  });

  it("Gemini: not set even on non-standard [DONE]", () => {
    expect(feedAll(GEMINI_SSE + "data: [DONE]\n\n", "gemini").sawTerminal).toBe(false);
  });
});

describe("StreamUsageExtractor contentTokens (usage 兜底估算)", () => {
  // 不预调 finish：用例需同时断言 finish() 返回值与 contentTokens
  function feed(sse: string, protocol: Protocol) {
    const extractor = new StreamUsageExtractor(protocol);
    extractor.feed(new TextEncoder().encode(sse));
    return extractor;
  }

  it("OpenAI: accumulates delta content, still null usage without usage chunk", () => {
    const sse =
      'data: {"id":"1","choices":[{"delta":{"content":"Hello world"}}]}\n\n' +
      'data: {"id":"1","choices":[{"delta":{"content":"你好"}}]}\n\n' +
      "data: [DONE]\n\n";
    const extractor = feed(sse, "openai");
    expect(extractor.finish()).toBeNull();
    // "Hello world" 11 ASCII → 3；"你好" → 2
    expect(extractor.contentTokens).toBe(5);
  });

  it("Anthropic: accumulates content_block_delta text", () => {
    const sse =
      'data: {"type":"content_block_delta","delta":{"type":"text_delta","text":"abcd"}}\n\n' +
      'data: {"type":"message_stop"}\n\n';
    const extractor = feed(sse, "anthropic");
    expect(extractor.finish()).toBeNull();
    expect(extractor.contentTokens).toBe(1);
  });

  it("Gemini: accumulates candidates parts text", () => {
    const sse =
      'data: {"candidates":[{"content":{"parts":[{"text":"hello"},{"text":"世界"}]}}]}\n\n';
    const extractor = feed(sse, "gemini");
    expect(extractor.finish()).toBeNull();
    expect(extractor.contentTokens).toBe(4); // ceil(5/4)=2 + 2
  });

  it("openai usage chunk (empty choices) adds nothing", () => {
    const sse =
      'data: {"id":"1","choices":[],"usage":{"prompt_tokens":10,"completion_tokens":5}}\n\n' +
      "data: [DONE]\n\n";
    const extractor = feed(sse, "openai");
    expect(extractor.finish()).not.toBeNull();
    expect(extractor.contentTokens).toBe(0);
  });

  it("openai: delta splitting does not change estimate (no per-delta rounding)", () => {
    // 同一 11 个 ASCII 字符：整段一次 delta 与拆成 11 个单字符 delta 结果必须一致
    const whole =
      'data: {"choices":[{"delta":{"content":"hello world"}}]}\n\n' + "data: [DONE]\n\n";
    const perChar =
      Array.from("hello world")
        .map((ch) => `data: {"choices":[{"delta":{"content":${JSON.stringify(ch)}}}]}\n\n`)
        .join("") + "data: [DONE]\n\n";
    expect(feed(whole, "openai").contentTokens).toBe(3);
    expect(feed(perChar, "openai").contentTokens).toBe(3);
  });

  it("mixed ascii + non-ascii split arbitrarily stays stable", () => {
    const sse =
      'data: {"type":"content_block_delta","delta":{"text":"ab"}}\n\n' +
      'data: {"type":"content_block_delta","delta":{"text":"你"}}\n\n' +
      'data: {"type":"content_block_delta","delta":{"text":"cd"}}\n\n';
    // 4 ASCII → ceil(4/4)=1；1 非 ASCII → 1；合计 2
    expect(feed(sse, "anthropic").contentTokens).toBe(2);
  });
});

// response id 归属（防跨 vk retrieve）依赖这里取对 id：中转常给每个 SSE 事件注入
// 事件级 id（evt_...），不能把事件 id 当成 response id，否则真 id 失去归属保护。
describe("StreamUsageExtractor responseId", () => {
  function collect(sse: string, protocol: Protocol = "openai"): StreamUsageExtractor {
    const extractor = new StreamUsageExtractor(protocol);
    extractor.feed(new TextEncoder().encode(sse));
    extractor.finish();
    return extractor;
  }

  it("先到带 evt_ 顶层 id 的事件、后到 response.created → 取 nested resp_ id", () => {
    const sse = [
      'data: {"id":"evt_1","type":"response.in_progress","response":{"usage":null}}',
      "",
      'data: {"id":"evt_2","type":"response.created","response":{"id":"resp_x"}}',
      "",
      'data: {"id":"evt_3","type":"response.completed","response":{"usage":{"input_tokens":3,"output_tokens":1}}}',
      "",
    ].join("\n");
    expect(collect(sse).responseId).toBe("resp_x");
  });

  it("纯 evt_ 事件级 id 的流 → null（不写错的归属）", () => {
    const sse = [
      'data: {"id":"evt_1","type":"response.output_text.delta","delta":"hi"}',
      "",
      'data: {"id":"evt_2","type":"response.completed","response":{"usage":{"input_tokens":1,"output_tokens":1}}}',
      "",
    ].join("\n");
    expect(collect(sse).responseId).toBeNull();
  });

  it("顶层 resp_ 前缀 id 直接接受（部分中转把 responses id 放在顶层）", () => {
    const sse = [
      'data: {"id":"resp_top","choices":[{"delta":{"content":"hi"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(collect(sse).responseId).toBe("resp_top");
  });

  it("chat 风格 chatcmpl_ 顶层 id 不当作 response id", () => {
    const sse = [
      'data: {"id":"chatcmpl-1","choices":[{"delta":{"content":"hi"}}]}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    expect(collect(sse).responseId).toBeNull();
  });
});
