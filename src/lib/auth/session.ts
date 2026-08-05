import { createHmac, createHash, timingSafeEqual } from "crypto";
import { GatewaySecretMissingError } from "@/lib/gateway/crypto";

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24h
const KEY_SALT = ":session-token";

export interface SessionPayload {
  exp: number; // 过期时间（epoch ms）
  epoch: number; // 签发时的 token_epoch（吊销版本号）
  keyId: string; // 签发时所用登录 key 的指纹
}

export function getSessionTtlMs(): number {
  const hours = Number(process.env.SESSION_TOKEN_TTL_HOURS);
  if (Number.isFinite(hours) && hours > 0) {
    return hours * 60 * 60 * 1000;
  }
  return DEFAULT_TTL_MS;
}

// 与 Edge 侧 middleware 保持一致的密钥派生方式（WebCrypto 侧为 SHA-256 摘要后导入 HMAC key）
export function deriveSessionKey(): Buffer {
  const secret = process.env.GATEWAY_SECRET;
  if (!secret) {
    throw new GatewaySecretMissingError();
  }
  return createHash("sha256").update(`${secret}${KEY_SALT}`).digest();
}

export function keyFingerprint(key: string): string {
  return createHash("sha256").update(`login-key:${key}`).digest("hex").slice(0, 16);
}

export function signSessionToken(epoch: number, keyId: string, ttlMs?: number): string {
  const payload: SessionPayload = {
    exp: Date.now() + (ttlMs ?? getSessionTtlMs()),
    epoch,
    keyId,
  };
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = createHmac("sha256", deriveSessionKey())
    .update(payloadB64)
    .digest("base64url");
  return `${payloadB64}.${sig}`;
}

export function verifySessionToken(token: string): SessionPayload | null {
  const dot = token.indexOf(".");
  if (dot <= 0) return null;
  const payloadB64 = token.slice(0, dot);
  const sig = token.slice(dot + 1);
  if (!payloadB64 || !sig) return null;

  const expected = createHmac("sha256", deriveSessionKey())
    .update(payloadB64)
    .digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (provided.length !== expected.length) return null;
  if (!timingSafeEqual(provided, expected)) return null;

  try {
    const parsed = JSON.parse(
      Buffer.from(payloadB64, "base64url").toString("utf8")
    ) as Partial<SessionPayload>;
    if (
      typeof parsed.exp !== "number" ||
      typeof parsed.epoch !== "number" ||
      typeof parsed.keyId !== "string"
    ) {
      return null;
    }
    return parsed as SessionPayload;
  } catch {
    return null;
  }
}

export function isTokenExpired(payload: SessionPayload): boolean {
  return payload.exp <= Date.now();
}

// 剩余有效期不足一半时滑动续期
export function shouldRenewToken(payload: SessionPayload, ttlMs?: number): boolean {
  const ttl = ttlMs ?? getSessionTtlMs();
  return payload.exp - Date.now() < ttl / 2;
}
