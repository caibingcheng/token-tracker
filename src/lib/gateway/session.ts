// 会话识别与粘性 binding 存储。
// sessionId = sha256(systemMessages 尾部 1024 字符 + 首条 user 消息文本前 1024 字符
//              + model + virtualKeyId + protocol)
import { createHash } from "crypto";
import { LRUCache } from "lru-cache";
import {
  CH_LBRACK,
  CH_QUOTE,
  CH_RBRACK,
  decodeJsonString,
  firstNonWs,
  forEachMember,
  skipWs,
  skipValue,
  type ValueSpan,
} from "./json-scan";

export const SESSION_STORE_MAX = 5000;
export const SESSION_STORE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SessionBinding {
  upstreamId: number;
  targetModel?: string; // route 粒度粘性（命名路由分类器决策绑定）；undefined = upstream 粒度（自动路由 failover）
  boundAt: number;
}

export interface SessionStoreLike {
  get(sessionId: string): SessionBinding | undefined;
  set(sessionId: string, upstreamId: number, targetModel?: string, now?: number): void;
  delete(sessionId: string): void;
}

export class SessionStore implements SessionStoreLike {
  private cache: LRUCache<string, SessionBinding>;

  constructor(max = SESSION_STORE_MAX, ttlMs = SESSION_STORE_TTL_MS) {
    this.cache = new LRUCache({ max, ttl: ttlMs });
  }

  get(sessionId: string): SessionBinding | undefined {
    return this.cache.get(sessionId);
  }

  set(sessionId: string, upstreamId: number, targetModel?: string, now = Date.now()): void {
    this.cache.set(sessionId, { upstreamId, targetModel, boundAt: now });
  }

  delete(sessionId: string): void {
    this.cache.delete(sessionId);
  }

  get size(): number {
    return this.cache.size;
  }
}

// 提取单条 message 的纯文本：string 直接返回，多模态数组只取 type === "text" 部分
function messageText(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const texts: string[] = [];
  for (const part of content) {
    if (
      typeof part === "object" &&
      part !== null &&
      (part as Record<string, unknown>).type === "text" &&
      typeof (part as Record<string, unknown>).text === "string"
    ) {
      texts.push((part as Record<string, unknown>).text as string);
    }
  }
  return texts.length > 0 ? texts.join("") : null;
}

// 从请求体派生会话指纹输入（不涉及任何隐私明文之外的敏感内容，最终会哈希）
export function extractSessionInput(
  bodyJson: unknown,
  model: string,
  virtualKeyId: number,
  protocol: string
): string {
  const systemTexts: string[] = [];
  let firstUserText: string | null = null;

  const obj = bodyJson as Record<string, unknown> | null;
  const messages = Array.isArray(obj?.messages) ? obj.messages : [];
  for (const msg of messages as unknown[]) {
    if (typeof msg !== "object" || msg === null) continue;
    const record = msg as Record<string, unknown>;
    const text = messageText(record.content);
    if (text === null) continue;
    if (record.role === "system") {
      systemTexts.push(text);
    } else if (record.role === "user" && firstUserText === null) {
      firstUserText = text;
    }
  }

  return (
    systemTexts.join("").slice(-1024) +
    (firstUserText ?? "").slice(0, 1024) +
    `\u0000${model}\u0000${virtualKeyId}\u0000${protocol}`
  );
}

// ---- 字节级镜像（>1MB 请求体不整包 JSON.parse，见 proxy.ts 分治） ----
// 与 extractSessionInput 语义逐点对齐：只解码 system / 首条 user 的文本，
// 图片等非文本值按区间跳过（off-heap），不物化消息树。指纹与解析路径一致
//（字符串区间经 JSON.parse 解码，转义语义相同）。

// 单条 message 的 content 文本：string 直接解码，数组只取 type==="text" 的 text
//（镜像 messageText）
function contentTextFromBytes(bytes: Uint8Array, contentSpan: ValueSpan): string | null {
  const i = firstNonWs(bytes, contentSpan);
  if (i < 0) return null;
  if (bytes[i] === CH_QUOTE) return decodeJsonString(bytes, contentSpan);
  if (bytes[i] !== CH_LBRACK) return null; // 非字符串非数组 → null（镜像 messageText）
  const texts: string[] = [];
  let p = skipWs(bytes, i + 1);
  while (p < contentSpan.end) {
    if (bytes[p] === CH_RBRACK) break;
    if (bytes[p] !== 123 /* { */) {
      const e = skipValue(bytes, p);
      if (e < 0) break;
      p = skipWs(bytes, e);
      if (p < contentSpan.end && bytes[p] === 44 /* , */) p = skipWs(bytes, p + 1);
      continue;
    }
    const part = forEachMember(bytes, p, () => true);
    if (part === null) break;
    const typeSpan = part.fields.get("type");
    const textSpan = part.fields.get("text");
    if (typeSpan && textSpan && decodeJsonString(bytes, typeSpan) === "text") {
      const t = decodeJsonString(bytes, textSpan);
      if (t !== null) texts.push(t);
    }
    p = skipWs(bytes, part.closeIdx + 1);
    if (p < contentSpan.end && bytes[p] === 44 /* , */) p = skipWs(bytes, p + 1);
  }
  return texts.length > 0 ? texts.join("") : null;
}

// 从 messages 字节区间派生会话指纹输入（镜像 extractSessionInput）。
// messagesSpan 缺失 / 非数组 → 与 bodyJson 无 messages 时相同（空前缀 + 后缀）。
export function extractSessionInputFromBytes(
  bytes: Uint8Array,
  messagesSpan: ValueSpan | undefined,
  model: string,
  virtualKeyId: number,
  protocol: string
): string {
  const systemTexts: string[] = [];
  let firstUserText: string | null = null;

  if (messagesSpan) {
    const open = firstNonWs(bytes, messagesSpan);
    if (open >= 0 && bytes[open] === CH_LBRACK) {
      let p = skipWs(bytes, open + 1);
      while (p < messagesSpan.end) {
        if (bytes[p] === CH_RBRACK) break;
        if (bytes[p] !== 123 /* { */) {
          const e = skipValue(bytes, p);
          if (e < 0) break;
          p = skipWs(bytes, e);
          if (p < messagesSpan.end && bytes[p] === 44 /* , */) p = skipWs(bytes, p + 1);
          continue;
        }
        const msg = forEachMember(bytes, p, () => true);
        if (msg === null) break;
        const roleSpan = msg.fields.get("role");
        const contentSpan = msg.fields.get("content");
        const text = contentSpan ? contentTextFromBytes(bytes, contentSpan) : null;
        if (text !== null) {
          const role = roleSpan ? decodeJsonString(bytes, roleSpan) : null;
          if (role === "system") systemTexts.push(text);
          else if (role === "user" && firstUserText === null) firstUserText = text;
        }
        p = skipWs(bytes, msg.closeIdx + 1);
        if (p < messagesSpan.end && bytes[p] === 44 /* , */) p = skipWs(bytes, p + 1);
      }
    }
  }

  return (
    systemTexts.join("").slice(-1024) +
    (firstUserText ?? "").slice(0, 1024) +
    `\u0000${model}\u0000${virtualKeyId}\u0000${protocol}`
  );
}

export function computeSessionId(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function buildSessionId(
  bodyJson: unknown,
  model: string,
  virtualKeyId: number,
  protocol: string
): string {
  return computeSessionId(extractSessionInput(bodyJson, model, virtualKeyId, protocol));
}
