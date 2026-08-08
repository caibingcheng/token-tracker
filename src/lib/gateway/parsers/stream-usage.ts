import type { Protocol } from "../model-router";
import type { ParsedUsage } from "./types";

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
}

interface AnthropicUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

interface GeminiUsageMetadata {
  promptTokenCount?: number;
  candidatesTokenCount?: number;
  cachedContentTokenCount?: number;
}

// 流式 SSE 增量 usage 提取器：边读边解析，只保留首尾 usage 小对象，
// 不持有完整响应体（内存 O(1)）。字段口径与 parsers/index.ts 的
// parseOpenAiStreaming / parseAnthropicStreaming / parseGeminiStreaming 完全一致。
export class StreamUsageExtractor {
  private decoder = new TextDecoder();
  private lineBuffer = "";
  private dataBuffer = "";
  private finished = false;

  // OpenAI / Gemini：最后一个 usage 事件胜出
  private lastOpenAiUsage: OpenAIUsage | null = null;
  private lastGeminiMetadata: GeminiUsageMetadata | null = null;

  // Anthropic：message_start 带 input usage，message_delta 带 output usage
  private anthropicInput: AnthropicUsage | null = null;
  private anthropicOutputTokens = 0;
  private anthropicFound = false;

  constructor(private protocol: Protocol) {}

  feed(chunk: Uint8Array): void {
    if (this.finished) return;
    this.lineBuffer += this.decoder.decode(chunk, { stream: true });
    this.consumeLines();
  }

  finish(): ParsedUsage | null {
    if (this.finished) return null;
    this.finished = true;
    this.lineBuffer += this.decoder.decode();
    this.consumeLines();
    // 无 \n 结尾的残余行（按行处理；handleLine 内部空行会终结事件）
    if (this.lineBuffer !== "") {
      this.handleLine(this.lineBuffer);
      this.lineBuffer = "";
    }
    // 无空行结尾的残余事件（等价 parseSseEvents 的尾部 buffer 处理）
    if (this.dataBuffer !== "") {
      this.processEvent(this.dataBuffer);
      this.dataBuffer = "";
    }
    return this.toParsedUsage();
  }

  private consumeLines(): void {
    let idx: number;
    while ((idx = this.lineBuffer.indexOf("\n")) !== -1) {
      const line = this.lineBuffer.slice(0, idx);
      this.lineBuffer = this.lineBuffer.slice(idx + 1);
      this.handleLine(line);
    }
  }

  private handleLine(line: string): void {
    // 空行终结当前事件
    if (line.trim() === "") {
      if (this.dataBuffer !== "") {
        this.processEvent(this.dataBuffer);
        this.dataBuffer = "";
      }
      return;
    }
    if (line.startsWith("data:")) {
      const value = line.slice(5).trimStart();
      if (this.dataBuffer !== "") this.dataBuffer += "\n";
      this.dataBuffer += value;
    }
    // event: / 注释行：忽略（dataBuffer 只累计 data: 行）
  }

  private processEvent(data: string): void {
    if (data === "[DONE]") return;
    // 快速过滤：命中协议相关的 usage 字段才 JSON.parse（大多数内容事件直接跳过，省 CPU）
    if (!this.matchesProtocol(data)) return;
    let json: unknown;
    try {
      json = JSON.parse(data);
    } catch {
      return;
    }
    this.applyEvent(json);
  }

  private matchesProtocol(data: string): boolean {
    switch (this.protocol) {
      case "anthropic":
        return data.includes('"message_start"') || data.includes('"message_delta"');
      case "gemini":
        return data.includes('"usageMetadata"');
      default:
        return data.includes('"usage"');
    }
  }

  private applyEvent(json: unknown): void {
    const event = json as Record<string, unknown>;
    if (this.protocol === "anthropic") {
      const type = event?.type;
      if (type === "message_start") {
        const usage = (event?.message as Record<string, unknown>)?.usage as AnthropicUsage | undefined;
        if (usage && typeof usage === "object") {
          this.anthropicInput = usage;
          this.anthropicFound = true;
        }
      } else if (type === "message_delta") {
        const usage = event?.usage as AnthropicUsage | undefined;
        if (usage && typeof usage === "object") {
          this.anthropicOutputTokens = Number(usage.output_tokens) || 0;
          this.anthropicFound = true;
        }
      }
      return;
    }
    if (this.protocol === "gemini") {
      const metadata = event?.usageMetadata as GeminiUsageMetadata | undefined;
      if (metadata && typeof metadata === "object") {
        this.lastGeminiMetadata = metadata;
      }
      return;
    }
    const usage = event?.usage as OpenAIUsage | undefined;
    if (usage && typeof usage === "object") {
      this.lastOpenAiUsage = usage;
    }
  }

  private toParsedUsage(): ParsedUsage | null {
    if (this.protocol === "anthropic") {
      if (!this.anthropicFound) return null;
      return {
        inputTokens: Number(this.anthropicInput?.input_tokens) || 0,
        outputTokens: this.anthropicOutputTokens,
        cacheRead: Number(this.anthropicInput?.cache_read_input_tokens) || 0,
        cacheWrite: Number(this.anthropicInput?.cache_creation_input_tokens) || 0,
        hasUsage: true,
      };
    }
    if (this.protocol === "gemini") {
      const metadata = this.lastGeminiMetadata;
      if (!metadata) return null;
      return {
        inputTokens: Math.max(0, Number(metadata.promptTokenCount) - (Number(metadata.cachedContentTokenCount) || 0)),
        outputTokens: Number(metadata.candidatesTokenCount) || 0,
        cacheRead: Number(metadata.cachedContentTokenCount) || 0,
        cacheWrite: 0,
        hasUsage: true,
      };
    }
    const usage = this.lastOpenAiUsage;
    if (!usage) return null;
    return {
      inputTokens: Math.max(0, Number(usage.prompt_tokens) - (Number(usage.prompt_tokens_details?.cached_tokens) || 0)),
      outputTokens: Number(usage.completion_tokens) || 0,
      cacheRead: Number(usage.prompt_tokens_details?.cached_tokens) || 0,
      cacheWrite: 0,
      hasUsage: true,
    };
  }
}
