// 会话识别与粘性 binding 存储。
// sessionId = sha256(systemMessages 尾部 1024 字符 + 首条 user 消息文本前 1024 字符
//              + model + virtualKeyId + protocol)
import { createHash } from "crypto";
import { LRUCache } from "lru-cache";

export const SESSION_STORE_MAX = 5000;
export const SESSION_STORE_TTL_MS = 24 * 60 * 60 * 1000;

export interface SessionBinding {
  upstreamId: number;
  boundAt: number;
}

export interface SessionStoreLike {
  get(sessionId: string): SessionBinding | undefined;
  set(sessionId: string, upstreamId: number, now?: number): void;
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

  set(sessionId: string, upstreamId: number, now = Date.now()): void {
    this.cache.set(sessionId, { upstreamId, boundAt: now });
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
