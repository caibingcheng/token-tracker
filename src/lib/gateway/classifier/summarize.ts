// 预算制请求摘要：在分类器模型的输入预算内尽可能多装有效消息。
// 策略：首条 user 消息必带（session 身份锚点，与 sessionId 哈希同源），
// 其余消息由新到旧贪心装填，装不下整条则保留头部截断；system 消息不送
//（可能含客户端敏感配置，且对复杂度判断帮助小）。
import type { Protocol } from "../model-router";

export const DEFAULT_CLASSIFIER_MAX_INPUT_TOKENS = 4096;
// 安全边际：chars/4 是粗略估算，留余量防实际 token 超限被分类器拒绝
export const SAFETY_MARGIN = 0.8;
const CHARS_PER_TOKEN = 4;

export interface ChatMessageText {
  role: string; // 'user' | 'assistant' | 'model'(gemini) 等
  text: string;
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

// content 字段归一化为纯文本：string 直取；数组取 text 类段拼接（OpenAI/Anthropic 多段内容）
function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const p = part as Record<string, unknown>;
    if (typeof p.text === "string") parts.push(p.text);
  }
  return parts.join("\n");
}

// 从请求体提取消息序列（按协议）：openai/anthropic 取 body.messages，gemini 取 body.contents
export function extractMessageTexts(bodyJson: unknown, protocol: Protocol): ChatMessageText[] {
  if (typeof bodyJson !== "object" || bodyJson === null) return [];
  const body = bodyJson as Record<string, unknown>;
  const result: ChatMessageText[] = [];

  if (protocol === "gemini") {
    const contents = body.contents;
    if (!Array.isArray(contents)) return [];
    for (const item of contents) {
      if (typeof item !== "object" || item === null) continue;
      const c = item as Record<string, unknown>;
      const role = typeof c.role === "string" ? c.role : "user";
      const text = contentToText(c.parts);
      if (text) result.push({ role, text });
    }
    return result;
  }

  const messages = body.messages;
  if (!Array.isArray(messages)) return [];
  for (const item of messages) {
    if (typeof item !== "object" || item === null) continue;
    const m = item as Record<string, unknown>;
    const role = typeof m.role === "string" ? m.role : "user";
    if (role === "system" || role === "developer") continue; // system 不送分类器
    const text = contentToText(m.content);
    if (text) result.push({ role, text });
  }
  return result;
}

function formatLine(role: string, text: string): string {
  return `[${role}] ${text}`;
}

// 在 budgetTokens 内构造 state：首条 user + 由新到旧贪心装填。
// 预算分配：首条 user 至多占一半（保身份锚点），剩余给最新消息（保当前任务上下文）。
export function buildStateSummary(
  messages: ChatMessageText[],
  budgetTokens: number
): string {
  const budgetChars = Math.floor(budgetTokens * CHARS_PER_TOKEN * SAFETY_MARGIN);
  if (budgetChars <= 0 || messages.length === 0) return "";

  const firstUserIdx = messages.findIndex((m) => m.role === "user");
  const lines: string[] = [];
  let used = 0;

  const pushTruncated = (role: string, text: string, maxChars: number): boolean => {
    const overhead = role.length + 3; // "[role] "
    const room = maxChars - overhead;
    if (room <= 0) return false;
    const clipped = text.length > room ? `${text.slice(0, room)}…` : text;
    lines.push(formatLine(role, clipped));
    used += overhead + clipped.length;
    return true;
  };

  // 1. 首条 user（身份锚点），至多占一半预算
  let anchor: ChatMessageText | null = null;
  if (firstUserIdx >= 0) {
    anchor = messages[firstUserIdx];
    pushTruncated(anchor.role, anchor.text, Math.floor(budgetChars / 2));
  }

  // 2. 由新到旧贪心装填（跳过已装的锚点消息），收集后按原顺序输出
  const tail: string[] = [];
  let skipped = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (i === firstUserIdx) continue;
    const m = messages[i];
    const remaining = budgetChars - used;
    const overhead = m.role.length + 3;
    if (remaining - overhead <= 0) {
      skipped++;
      continue;
    }
    const room = remaining - overhead;
    const wasClipped = m.text.length > room;
    const clipped = wasClipped ? `${m.text.slice(0, room)}…` : m.text;
    tail.unshift(formatLine(m.role, clipped));
    used += overhead + clipped.length;
    if (wasClipped) {
      skipped++; // 该条被截断，更旧的消息均不可见
      break;
    }
  }
  if (skipped > 0 && (anchor !== null || tail.length > 0)) {
    lines.push("...");
  }
  lines.push(...tail);
  return lines.join("\n");
}
