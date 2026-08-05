import { createHmac, randomBytes } from "crypto";

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

export function verifyTotpCode(
  secret: string,
  code: string,
  timestampMs: number = Date.now()
): boolean {
  if (!/^\d{6}$/.test(code)) return false;
  for (let w = -TOTP_WINDOW; w <= TOTP_WINDOW; w++) {
    const t = timestampMs + w * TOTP_TIME_STEP_SECONDS * 1000;
    if (generateTotpCode(secret, t) === code) return true;
  }
  return false;
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
