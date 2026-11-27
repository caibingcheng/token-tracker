// relay 设备（sub node）配对与 token 的纯逻辑部分（码生成/归一化/哈希/限流常量）。
// DB 读写见 store.ts；本文件不碰 DB，可单测。
import { createHash, randomBytes, timingSafeEqual } from "crypto";

// 字符集排除易混淆的 0 O I 1（与 recovery codes 同集）：24 字母 + 8 数字 = 32
export const PAIRING_CODE_CHARSET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
export const PAIRING_CODE_LENGTH = 8;
export const PAIRING_TTL_MS = 600_000; // 600s
export const PAIRING_POLL_INTERVAL_S = 5;
export const PAIRING_MAX_POLLS = 200;
export const PAIRING_MAX_SECRET_FAILURES = 3;
export const PAIRING_MAX_PENDING_PER_IP = 3;
export const PAIRING_SLOW_DOWN_MAX_INTERVAL_S = 30;

export function generatePairingCode(): string {
  const bytes = randomBytes(PAIRING_CODE_LENGTH);
  let raw = "";
  for (let i = 0; i < PAIRING_CODE_LENGTH; i++) {
    raw += PAIRING_CODE_CHARSET[bytes[i]! % PAIRING_CODE_CHARSET.length];
  }
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

// 归一化：大写、去掉所有非字符集字符（连字符/空格/粘贴杂字符），长度必须为 8
export function normalizePairingCode(input: string): string | null {
  const upper = input.toUpperCase();
  let out = "";
  for (const ch of upper) {
    if (PAIRING_CODE_CHARSET.includes(ch)) out += ch;
  }
  return out.length === PAIRING_CODE_LENGTH ? out : null;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function pairingCodeHash(normalizedCode: string): string {
  return sha256Hex(normalizedCode);
}

// `dt-` + 32 base64url（24 随机字节）；中心只存 sha256
export function generateDeviceToken(): string {
  return `dt-${randomBytes(24).toString("base64url")}`;
}

export function deviceTokenHash(token: string): string {
  return sha256Hex(token);
}

export function isDeviceTokenShaped(token: string): boolean {
  return /^dt-[A-Za-z0-9_-]{32}$/.test(token);
}

export function safeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a, "hex"), Buffer.from(b, "hex"));
  } catch {
    return false;
  }
}

// 设备展示名的兜底清洗（hostname 常带个人信息，且默认值来自 relay）
export function sanitizeDeviceName(raw: unknown, fallback: string): string {
  const name = typeof raw === "string" ? raw.trim().replace(/[\u0000-\u001f\u007f]/g, "") : "";
  const chosen = name !== "" ? name : fallback;
  return chosen.slice(0, 64);
}
