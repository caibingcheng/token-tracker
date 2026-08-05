import { describe, it, expect } from "vitest";
import {
  parseOpenAiNonStreaming,
  parseOpenAiStreaming,
  parseAnthropicNonStreaming,
  parseAnthropicStreaming,
  parseGeminiNonStreaming,
  parseGeminiStreaming,
  parseSseEvents,
} from "./index";

describe("OpenAI parser", () => {
  it("parses non-streaming usage", () => {
    const result = parseOpenAiNonStreaming({
      usage: { prompt_tokens: 100, completion_tokens: 50, prompt_tokens_details: { cached_tokens: 30 } },
    });
    expect(result).toEqual({ inputTokens: 100, outputTokens: 50, cacheRead: 30, cacheWrite: 0, hasUsage: true });
  });

  it("handles missing details", () => {
    const result = parseOpenAiNonStreaming({ usage: { prompt_tokens: 10, completion_tokens: 5 } });
    expect(result?.cacheRead).toBe(0);
  });

  it("returns null without usage", () => {
    expect(parseOpenAiNonStreaming({ choices: [] })).toBeNull();
  });

  it("parses streaming usage from trailing chunk", () => {
    const sse = [
      'data: {"id":"1","choices":[{"delta":{"content":"hi"}}]}',
      "",
      'data: {"id":"1","choices":[],"usage":{"prompt_tokens":200,"completion_tokens":80,"prompt_tokens_details":{"cached_tokens":120}}}',
      "",
      "data: [DONE]",
      "",
    ].join("\n");
    const result = parseOpenAiStreaming(sse);
    expect(result).toEqual({ inputTokens: 200, outputTokens: 80, cacheRead: 120, cacheWrite: 0, hasUsage: true });
  });

  it("returns null when streaming has no usage chunk", () => {
    const sse = 'data: {"id":"1","choices":[{"delta":{"content":"x"}}]}\n\ndata: [DONE]\n\n';
    expect(parseOpenAiStreaming(sse)).toBeNull();
  });
});

describe("Anthropic parser", () => {
  it("parses non-streaming usage", () => {
    const result = parseAnthropicNonStreaming({
      usage: { input_tokens: 300, output_tokens: 90, cache_read_input_tokens: 100, cache_creation_input_tokens: 40 },
    });
    expect(result).toEqual({ inputTokens: 300, outputTokens: 90, cacheRead: 100, cacheWrite: 40, hasUsage: true });
  });

  it("returns null without usage", () => {
    expect(parseAnthropicNonStreaming({ content: [] })).toBeNull();
  });

  it("parses streaming usage from message_start + message_delta", () => {
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"usage":{"input_tokens":250,"cache_read_input_tokens":60,"cache_creation_input_tokens":25}}}',
      "",
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"type":"text_delta","text":"hello"}}',
      "",
      'event: message_delta\ndata: {"type":"message_delta","usage":{"output_tokens":77}}',
      "",
      'event: message_stop\ndata: {"type":"message_stop"}',
      "",
    ].join("\n");
    const result = parseAnthropicStreaming(sse);
    expect(result).toEqual({ inputTokens: 250, outputTokens: 77, cacheRead: 60, cacheWrite: 25, hasUsage: true });
  });

  it("returns null when no usage events", () => {
    const sse = 'data: {"type":"message_stop"}\n\n';
    expect(parseAnthropicStreaming(sse)).toBeNull();
  });
});

describe("Gemini parser", () => {
  it("parses non-streaming usageMetadata", () => {
    const result = parseGeminiNonStreaming({
      usageMetadata: { promptTokenCount: 400, candidatesTokenCount: 120, cachedContentTokenCount: 200 },
    });
    expect(result).toEqual({ inputTokens: 400, outputTokens: 120, cacheRead: 200, cacheWrite: 0, hasUsage: true });
  });

  it("returns null without usageMetadata", () => {
    expect(parseGeminiNonStreaming({ candidates: [] })).toBeNull();
  });

  it("parses streaming usageMetadata (cumulative, last wins)", () => {
    const sse = [
      'data: {"candidates":[{"content":{"parts":[{"text":"a"}]}}]}',
      "",
      'data: {"candidates":[{"content":{"parts":[{"text":"b"}]}}],"usageMetadata":{"promptTokenCount":500,"candidatesTokenCount":150,"cachedContentTokenCount":300}}',
      "",
    ].join("\n");
    const result = parseGeminiStreaming(sse);
    expect(result).toEqual({ inputTokens: 500, outputTokens: 150, cacheRead: 300, cacheWrite: 0, hasUsage: true });
  });
});

describe("parseSseEvents", () => {
  it("parses multiple events and ignores non-data lines", () => {
    const sse = [
      ": comment line",
      "event: message_start",
      'data: {"a":1}',
      "",
      'data: {"b":2}',
      "",
    ].join("\n");
    const events = parseSseEvents(sse);
    expect(events).toEqual([{ a: 1 }, { b: 2 }]);
  });

  it("drops malformed data payloads", () => {
    const sse = 'data: {not-json}\n\ndata: {"ok":true}\n\n';
    expect(parseSseEvents(sse)).toEqual([{ ok: true }]);
  });

  it("returns empty array for empty input", () => {
    expect(parseSseEvents("")).toEqual([]);
  });
});
