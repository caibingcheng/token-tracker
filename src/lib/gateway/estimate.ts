// usage 估算兜底：上游（多为第三方中转）流式响应不发 usage chunk 时，
// 按请求 messages 与响应文本估算 token，记库 status='estimated'。
// 估算口径：非 ASCII 字符（CJK 等）1 字 ≈ 1 token，ASCII 字符 4 字 ≈ 1 token。
import type { Protocol } from "./model-router";
import type { ValueSpan } from "./json-scan";
import { firstNonWs } from "./json-scan";

export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  let nonAscii = 0;
  let ascii = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! > 127) nonAscii++;
    else ascii++;
  }
  return nonAscii + Math.ceil(ascii / 4);
}

function collectText(value: unknown, parts: string[]): void {
  if (typeof value === "string") {
    parts.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      const text = (item as Record<string, unknown>)?.text;
      if (typeof text === "string") parts.push(text);
    }
  }
}

// 从请求 body 估算 input tokens：OpenAI chat 取 messages、responses 取 input，
// Anthropic 取 messages，Gemini 取 contents。
// 直接对消息数组 JSON 估算（结构开销 ~10%，与 tool_calls 等真实占用同量级）。
export function estimateInputTokens(bodyJson: unknown, protocol: Protocol): number {
  if (typeof bodyJson !== "object" || bodyJson === null || Array.isArray(bodyJson)) return 0;
  const body = bodyJson as Record<string, unknown>;
  if (protocol === "gemini") return estimateContainer(body.contents);
  if (protocol === "anthropic") return estimateContainer(body.messages);
  // OpenAI：chat 用 messages，responses API 用 input（string 或 item 数组）
  return estimateContainer(body.messages) + estimateContainer(body.input);
}

function estimateContainer(value: unknown): number {
  if (typeof value === "string") return estimateTokens(value);
  if (!Array.isArray(value) || value.length === 0) return 0;
  return estimateTokens(JSON.stringify(value));
}

// 按 UTF-8 字节区间估算 token（与 estimateTokens 同口径：>127 码点 1 字 1 token，
// ASCII 4 字 1 token；转义/结构开销与 stringify 口径同量级，均计入 ASCII）。
// 零解码零分配——>1MB 请求体不整包 parse 时的 input 估算路径。
function estimateUtf8(bytes: Uint8Array, start: number, end: number): number {
  let ascii = 0;
  let nonAscii = 0;
  for (let i = start; i < end; i++) {
    const b = bytes[i];
    if (b < 0x80) {
      ascii++;
    } else {
      nonAscii++;
      while (i + 1 < end && (bytes[i + 1] & 0xc0) === 0x80) i++; // 跳过 UTF-8 续字节
    }
  }
  return nonAscii + Math.ceil(ascii / 4);
}

// 字节区间版 input 估算（镜像 estimateInputTokens 的容器选择与求和，
// 不物化消息树；容器 span 直接按原始 JSON 字节计数——与 stringify 口径同量级）。
export function estimateInputTokensFromSpans(
  bytes: Uint8Array,
  fields: ReadonlyMap<string, ValueSpan>,
  protocol: Protocol
): number {
  const keys =
    protocol === "gemini"
      ? ["contents"]
      : protocol === "anthropic"
        ? ["messages"]
        : ["messages", "input"];
  let total = 0;
  for (const key of keys) {
    const span = fields.get(key);
    if (!span) continue;
    total += estimateContainerSpan(bytes, span);
  }
  return total;
}

// 镜像 estimateContainer：字符串只计内层（不去引号会多算），数组计整个区间
//（结构字符与 stringify 口径同量级），其余类型（数字/布尔/对象）计 0。
function estimateContainerSpan(bytes: Uint8Array, span: ValueSpan): number {
  const i = firstNonWs(bytes, span);
  if (i < 0) return 0;
  const b = bytes[i];
  if (b === 34 /* " */ && span.end - 1 > i) return estimateUtf8(bytes, i + 1, span.end - 1);
  if (b === 91 /* [ */) return estimateUtf8(bytes, span.start, span.end);
  return 0;
}

// 从非流式响应 body 估算 output tokens：提取各协议 assistant 输出文本。
export function estimateOutputTokens(fullText: string, protocol: Protocol): number {
  let json: unknown;
  try {
    json = JSON.parse(fullText);
  } catch {
    return 0;
  }
  // 根节点必须是普通对象：JSON.parse("null") / 标量 / 数组访问字段会抛错，
  // 异常会冒到 proxy 外层使 onUsage 不执行，连 no_usage 行都丢掉
  if (typeof json !== "object" || json === null || Array.isArray(json)) return 0;
  const root = json as Record<string, unknown>;
  const parts: string[] = [];
  if (protocol === "anthropic") {
    collectText(root.content, parts);
  } else if (protocol === "gemini") {
    if (Array.isArray(root.candidates)) {
      for (const candidate of root.candidates) {
        const content = (candidate as Record<string, unknown>)?.content as
          | Record<string, unknown>
          | undefined;
        collectText(content?.parts, parts);
      }
    }
  } else {
    // responses API：output[].content[].text
    if (Array.isArray(root.output)) {
      for (const item of root.output) {
        const content = (item as Record<string, unknown>)?.content;
        if (!Array.isArray(content)) continue;
        for (const block of content) {
          const text = (block as Record<string, unknown>)?.text;
          if (typeof text === "string") parts.push(text);
        }
      }
    }
    // chat completions：choices[].message.content / choices[].text
    if (Array.isArray(root.choices)) {
      for (const choice of root.choices) {
        const c = choice as Record<string, unknown>;
        const message = c.message as Record<string, unknown> | undefined;
        collectText(message?.content ?? c.text, parts);
      }
    }
  }
  return estimateTokens(parts.join(""));
}
