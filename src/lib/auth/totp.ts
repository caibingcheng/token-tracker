import { createHmac, randomBytes, timingSafeEqual } from "crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
export const TOTP_TIME_STEP_SECONDS = 30;
export const TOTP_WINDOW = 1;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let output = "";
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i]!;
    bits += 8;
    while (bits >= 5) {
      output += BASE32_ALPHABET[(value >>> (bits - 5)) & 31]!;
      bits -= 5;
    }
  }
  if (bits > 0) {
    output += BASE32_ALPHABET[(value << (5 - bits)) & 31]!;
  }
  return output;
}

export function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of cleaned) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function generateTotpCode(
  secret: string,
  timestampMs: number = Date.now()
): string {
  const counter = Math.floor(timestampMs / 1000 / TOTP_TIME_STEP_SECONDS);
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const hash = createHmac("sha1", base32Decode(secret)).update(msg).digest();
  const offset = hash[hash.length - 1]! & 0x0f;
  const code =
    ((hash[offset]! & 0x7f) << 24) |
    ((hash[offset + 1]! & 0xff) << 16) |
    ((hash[offset + 2]! & 0xff) << 8) |
    (hash[offset + 3]! & 0xff);
  return String(code % 1000000).padStart(6, "0");
}

// 匹配 ±TOTP_WINDOW 窗口内的动态码，命中返回命中的时间步计数（未命中 null）。
// 计数就是重放防护的比较基准：同一时间步只能成功一次。
export function matchTotpCounter(
  secret: string,
  code: string,
  timestampMs: number = Date.now()
): number | null {
  if (!/^\d{6}$/.test(code)) return null;
  const baseCounter = Math.floor(timestampMs / 1000 / TOTP_TIME_STEP_SECONDS);
  for (let w = -TOTP_WINDOW; w <= TOTP_WINDOW; w++) {
    const counter = baseCounter + w;
    const expected = generateTotpCode(secret, counter * TOTP_TIME_STEP_SECONDS * 1000);
    // 常量时间比较（两侧都已被 /^\d{6}$/ 与 padStart 约束为等长，直接喂 timingSafeEqual）
    if (timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(code, "utf8"))) {
      return counter;
    }
  }
  return null;
}

export function verifyTotpCode(
  secret: string,
  code: string,
  timestampMs: number = Date.now()
): boolean {
  return matchTotpCounter(secret, code, timestampMs) !== null;
}

export function buildOtpAuthUri(
  secret: string,
  issuer: string,
  account: string
): string {
  return (
    `otpauth://totp/${encodeURIComponent(issuer)}:${encodeURIComponent(account)}` +
    `?secret=${secret}&issuer=${encodeURIComponent(issuer)}` +
    `&algorithm=SHA1&digits=6&period=${TOTP_TIME_STEP_SECONDS}`
  );
}
