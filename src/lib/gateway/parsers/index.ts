import type { ParsedUsage } from "./types";

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

export function parseOpenAiNonStreaming(json: unknown): ParsedUsage | null {
  const usage = (json as Record<string, unknown>)?.usage as OpenAIUsage | undefined;
  if (!usage) return null;
  return {
    inputTokens: Math.max(0, Number(usage.prompt_tokens) - (Number(usage.prompt_tokens_details?.cached_tokens) || 0)),
    outputTokens: Number(usage.completion_tokens) || 0,
    cacheRead: Number(usage.prompt_tokens_details?.cached_tokens) || 0,
    cacheWrite: 0,
    hasUsage: true,
  };
}

// 流式：末尾 chunk 的 usage 字段（依赖客户端 stream_options.include_usage）
export function parseOpenAiStreaming(sseText: string): ParsedUsage | null {
  const events = parseSseEvents(sseText);
  let lastUsage: OpenAIUsage | null = null;
  for (const event of events) {
    const usage = (event as Record<string, unknown>)?.usage as OpenAIUsage | undefined;
    if (usage && typeof usage === "object") {
      lastUsage = usage;
    }
  }
  if (!lastUsage) return null;
  return {
    inputTokens: Math.max(0, Number(lastUsage.prompt_tokens) - (Number(lastUsage.prompt_tokens_details?.cached_tokens) || 0)),
    outputTokens: Number(lastUsage.completion_tokens) || 0,
    cacheRead: Number(lastUsage.prompt_tokens_details?.cached_tokens) || 0,
    cacheWrite: 0,
    hasUsage: true,
  };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

export function parseAnthropicNonStreaming(json: unknown): ParsedUsage | null {
  const usage = (json as Record<string, unknown>)?.usage as AnthropicUsage | undefined;
  if (!usage) return null;
  return {
    inputTokens: Number(usage.input_tokens) || 0,
    outputTokens: Number(usage.output_tokens) || 0,
    cacheRead: Number(usage.cache_read_input_tokens) || 0,
    cacheWrite: Number(usage.cache_creation_input_tokens) || 0,
    hasUsage: true,
  };
}

// 流式：message_start 事件带 input usage，message_delta 事件带 output usage
export function parseAnthropicStreaming(sseText: string): ParsedUsage | null {
  const events = parseSseEvents(sseText);
  let input: AnthropicUsage | null = null;
  let outputTokens = 0;
  let found = false;

  for (const event of events as Array<Record<string, unknown>>) {
    const type = event?.type;
    if (type === "message_start") {
      const usage = (event?.message as Record<string, unknown>)?.usage as AnthropicUsage | undefined;
      if (usage) {
        input = usage;
        found = true;
      }
    } else if (type === "message_delta") {
      const usage = event?.usage as AnthropicUsage | undefined;
      if (usage) {
        outputTokens = Number(usage.output_tokens) || 0;
        found = true;
      }
    }
  }

  if (!found) return null;
  return {
    inputTokens: Number(input?.input_tokens) || 0,
    outputTokens,
    cacheRead: Number(input?.cache_read_input_tokens) || 0,
    cacheWrite: Number(input?.cache_creation_input_tokens) || 0,
    hasUsage: true,
  };
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

export function parseGeminiNonStreaming(json: unknown): ParsedUsage | null {
  const metadata = (json as Record<string, unknown>)?.usageMetadata as GeminiUsageMetadata | undefined;
  if (!metadata) return null;
  return {
    inputTokens: Math.max(0, Number(metadata.promptTokenCount) - (Number(metadata.cachedContentTokenCount) || 0)),
    outputTokens: Number(metadata.candidatesTokenCount) || 0,
    cacheRead: Number(metadata.cachedContentTokenCount) || 0,
    cacheWrite: 0,
    hasUsage: true,
  };
}

// 流式：chunk 的 usageMetadata 为累计值，取最后一个非空
export function parseGeminiStreaming(sseText: string): ParsedUsage | null {
  const events = parseSseEvents(sseText);
  let last: GeminiUsageMetadata | null = null;
  for (const event of events) {
    const metadata = (event as Record<string, unknown>)?.usageMetadata as GeminiUsageMetadata | undefined;
    if (metadata && typeof metadata === "object") {
      last = metadata;
    }
  }
  if (!last) return null;
  return {
    inputTokens: Math.max(0, Number(last.promptTokenCount) - (Number(last.cachedContentTokenCount) || 0)),
    outputTokens: Number(last.candidatesTokenCount) || 0,
    cacheRead: Number(last.cachedContentTokenCount) || 0,
    cacheWrite: 0,
    hasUsage: true,
  };
}

// 解析 SSE 文本为事件 JSON 数组（跳过注释/空行/event: 行）
export function parseSseEvents(sseText: string): unknown[] {
  const events: unknown[] = [];
  let buffer = "";
  for (const line of sseText.split("\n")) {
    if (line.startsWith("data:")) {
      const value = line.slice(5).trimStart();
      if (buffer) buffer += "\n";
      buffer += value;
    } else if (line.trim() === "" && buffer) {
      const parsed = tryParseJson(buffer);
      if (parsed !== undefined) events.push(parsed);
      buffer = "";
    }
  }
  if (buffer) {
    const parsed = tryParseJson(buffer);
    if (parsed !== undefined) events.push(parsed);
  }
  return events;
}

function tryParseJson(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
