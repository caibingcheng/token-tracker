import type { Protocol } from "../model-router";
import type { ParsedUsage } from "./types";

interface OpenAIUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
    cache_write_tokens?: number;
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
// 与 parsers/index.ts 的 openAiUsageOf 字段口径一致：
// chat 风格（prompt_tokens/completion_tokens）与 responses 风格（input_tokens/output_tokens）
function openAiInputTokens(usage: OpenAIUsage): number {
  return Number(usage.input_tokens ?? usage.prompt_tokens) || 0;
}

function openAiOutputTokens(usage: OpenAIUsage): number {
  return Number(usage.output_tokens ?? usage.completion_tokens) || 0;
}

function openAiCachedTokens(usage: OpenAIUsage): number {
  return (
    Number(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens) ||
    0
  );
}

// 提取 usage：chat 流式为事件顶层 usage；responses 流式在 response.completed 的嵌套 response.usage
function openAiUsageOf(event: unknown): OpenAIUsage | undefined {
  const obj = event as Record<string, unknown> | undefined;
  if (!obj || typeof obj !== "object") return undefined;
  const direct = obj.usage as OpenAIUsage | undefined;
  if (direct && typeof direct === "object") return direct;
  if (obj.type === "response.completed") {
    const nested = (obj.response as Record<string, unknown> | undefined)?.usage as
      | OpenAIUsage
      | undefined;
    if (nested && typeof nested === "object") return nested;
  }
  return undefined;
}

export class StreamUsageExtractor {
  private decoder = new TextDecoder();
  private lineBuffer = "";
  private dataBuffer = "";
  private finished = false;

  // 是否已见协议终止事件（[DONE] / response.completed / message_stop）。
  // Gemini 流无终止事件，恒为 false。proxy 据此区分「响应完整后客户端断开」
  // 与「真中断」，前者不标 client_aborted。
  sawTerminal = false;

  // responses create 的 response id：responses 风格在 response.created 的 response.id，
  // chat 风格在事件顶层 id（仅 resp_ 前缀事件接受，见 applyEvent）。
  // proxy 用它记 vk 归属（防跨 vk retrieve）。
  responseId: string | null = null;

  // OpenAI / Gemini：最后一个 usage 事件胜出
  private lastOpenAiUsage: OpenAIUsage | null = null;
  private lastGeminiMetadata: GeminiUsageMetadata | null = null;

  // Anthropic：message_start 带 input usage，message_delta 带 output usage
  private anthropicInput: AnthropicUsage | null = null;
  private anthropicOutputTokens = 0;
  private anthropicFound = false;

  // 流内 assistant 输出内容的累计字符数（usage 缺失时兜底估 output 用）。
  // 按字符计数而不是逐 delta 取整：SSE 常把同一段文本拆成多个 delta，
  // 每段各自 Math.ceil(ascii/4) 会把 11 个 ASCII 字符估成 4 个 token 而非 3 个。
  // 逐字累加计数仍为 O(1) 内存，不持有原文；thinking/reasoning 不计入（会低估）。
  private contentAsciiChars = 0;
  private contentNonAsciiChars = 0;

  get contentTokens(): number {
    return this.contentNonAsciiChars + Math.ceil(this.contentAsciiChars / 4);
  }

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
    if (data === "[DONE]") {
      // [DONE] 是 OpenAI chat 的终止哨兵，仅 openai 协议识别（responses 由
      // response.completed 置位）；Gemini/Anthropic 收到也不豁免中断标记
      if (this.protocol === "openai") this.sawTerminal = true;
      return;
    }
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
        // content_block_delta 为文本增量事件：usage 缺失兜底时需累计 output
        return (
          data.includes('"message_start"') ||
          data.includes('"message_delta"') ||
          data.includes('"message_stop"') ||
          data.includes('"content_block_delta"')
        );
      case "gemini":
        return data.includes('"usageMetadata"') || data.includes('"candidates"');
      default:
        // choices 覆盖全部 chat chunk（含 content delta 与 usage chunk）；
        // response.output_text.delta 为 responses API 流式文本增量事件；
        // response.created 是 responses 流的首个事件（带 response.id，供归属记录）
        return (
          data.includes('"usage"') ||
          data.includes('"response.completed"') ||
          data.includes('"response.created"') ||
          data.includes('"choices"') ||
          data.includes('"response.output_text.delta"')
        );
    }
  }

  private applyEvent(json: unknown): void {
    const event = json as Record<string, unknown>;
    this.accumulateContent(event);
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
      } else if (type === "message_stop") {
        this.sawTerminal = true;
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
    if (event?.type === "response.completed") {
      this.sawTerminal = true;
    }
    // response id：nested `event.response.id` 优先（response.created 的真实 id）；
    // 顶层 id 只在带 `resp_` 前缀时接受。为什么不能「首个顶层 id 胜出」：中转/网关常给
    // 每个 SSE 事件注入事件级 id（`evt_...`），首事件不是 response.created 时就会把事件 id
    // 当成 response id 写进归属表 → 真 id 反而无映射、跨 vk 校验退回 fail-open（保护降级）。
    if (this.responseId === null) {
      const nestedId = (event?.response as Record<string, unknown> | undefined)?.id;
      const topLevelId = event?.id;
      if (typeof nestedId === "string" && nestedId !== "") {
        this.responseId = nestedId;
      } else if (typeof topLevelId === "string" && topLevelId.startsWith("resp_")) {
        this.responseId = topLevelId;
      }
    }
    const usage = openAiUsageOf(event);
    if (usage && typeof usage === "object") {
      this.lastOpenAiUsage = usage;
    }
  }

  // 累计流内输出文本字符数（usage 兜底用）；事件里无输出文本时零开销
  private accumulateContent(event: Record<string, unknown>): void {
    if (this.protocol === "anthropic") {
      if (event.type === "content_block_delta") {
        const delta = event.delta as Record<string, unknown> | undefined;
        if (typeof delta?.text === "string") this.countContentChars(delta.text);
      }
      return;
    }
    if (this.protocol === "gemini") {
      const candidates = event.candidates;
      if (Array.isArray(candidates)) {
        for (const candidate of candidates) {
          const parts = (candidate as Record<string, unknown>)?.content as
            | Record<string, unknown>
            | undefined;
          if (!Array.isArray(parts?.parts)) continue;
          for (const part of parts.parts) {
            const text = (part as Record<string, unknown>)?.text;
            if (typeof text === "string") this.countContentChars(text);
          }
        }
      }
      return;
    }
    if (event.type === "response.output_text.delta") {
      const delta = event.delta;
      if (typeof delta === "string") this.countContentChars(delta);
      return;
    }
    const choices = event.choices;
    if (Array.isArray(choices)) {
      for (const choice of choices) {
        const delta = (choice as Record<string, unknown>)?.delta as
          | Record<string, unknown>
          | undefined;
        if (typeof delta?.content === "string") this.countContentChars(delta.content);
      }
    }
  }

  // 只累加字符数，取整留到 contentTokens 读取时统一做（避免跨 delta 重复取整）
  private countContentChars(text: string): void {
    for (const ch of text) {
      if (ch.codePointAt(0)! > 127) this.contentNonAsciiChars++;
      else this.contentAsciiChars++;
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
      inputTokens: Math.max(0, openAiInputTokens(usage) - openAiCachedTokens(usage)),
      outputTokens: openAiOutputTokens(usage),
      cacheRead: openAiCachedTokens(usage),
      cacheWrite: Number(usage.input_tokens_details?.cache_write_tokens) || 0,
      hasUsage: true,
    };
  }
}
