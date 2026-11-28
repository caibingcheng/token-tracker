// lease（真实 upstream key 的信封）加解密：两端共用，纯 node:crypto。
//
// 方案：每 plan 新建一对 X25519 临时密钥 → 与 device 公钥做 ECDH 得到 shared →
// HKDF-SHA256(shared, salt=planId, info="relay-key-lease-v1", 32) 作 AES-256-GCM key。
// AAD 绑定 planId|upstreamId|keyId，防止把 hop A 的 lease 挪到 hop B 用。
//
// 保密边界（必须写进 README 安全段）：中心只存 device 公钥，不存在能解开全部 lease 的
// 对称密钥；中心被攻破只泄露密文 → relay 被攻破泄露「已下发」的 upstream key。
import {
  createCipheriv,
  createDecipheriv,
  createPrivateKey,
  createPublicKey,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
} from "crypto";
import type { Protocol } from "./model-router";

export const LEASE_WIRE_VERSION = "v1";
export const LEASE_TTL_MS = 60_000;
export const LEASE_CLOCK_SKEW_MS = 120_000;
const HKDF_INFO = "relay-key-lease-v1";

export interface LeasePayload {
  v: 1;
  planId: string;
  upstreamId: number;
  keyId: number;
  apiKey: string;
  protocol: Protocol;
  url: string;
  proxyUrl: string | null;
  headers: Record<string, string>;
  requiresPrivateNetwork: boolean;
  /** epoch ms（与 device_plans.expires_at 同单位） */
  expiresAt: number;
}

function deriveKey(shared: Buffer, planId: string): Buffer {
  const out = hkdfSync("sha256", shared, Buffer.from(planId, "utf8"), Buffer.from(HKDF_INFO, "utf8"), 32);
  return Buffer.from(out);
}

function aad(planId: string, upstreamId: number, keyId: number): Buffer {
  return Buffer.from(`${planId}|${upstreamId}|${keyId}`, "utf8");
}

function exportX25519PublicKey(key: import("crypto").KeyObject): string {
  return Buffer.from(key.export({ type: "spki", format: "der" }) as Buffer).toString("base64url");
}

/** 封装一次 plan 的 hop lease；devicePublicKeyB64u = X25519 SPKI DER（base64url） */
export function sealLease(payload: LeasePayload, devicePublicKeyB64u: string): string {
  const { publicKey: ephPub, privateKey: ephPriv } = generateKeyPairSync("x25519");
  const devicePub = createPublicKey({
    key: Buffer.from(devicePublicKeyB64u, "base64url"),
    format: "der",
    type: "spki",
  });
  const shared = diffieHellman({ privateKey: ephPriv, publicKey: devicePub });
  const key = deriveKey(shared, payload.planId);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(aad(payload.planId, payload.upstreamId, payload.keyId));
  const ct = Buffer.concat([
    cipher.update(Buffer.from(JSON.stringify(payload), "utf8")),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return [
    LEASE_WIRE_VERSION,
    exportX25519PublicKey(ephPub),
    iv.toString("base64url"),
    tag.toString("base64url"),
    ct.toString("base64url"),
  ].join(".");
}

/**
 * 解开 lease；任何结构/AAD/解密失败一律返回 null（fail-closed，绝不抛给上层）。
 * expected 用于校验 AAD 绑定的 hop 身份（防跨 hop 复用）。
 */
export function openLease(
  wire: string,
  devicePrivateKeyPem: string,
  expected: { planId: string; upstreamId: number; keyId: number }
): LeasePayload | null {
  try {
    const parts = wire.split(".");
    if (parts.length !== 5 || parts[0] !== LEASE_WIRE_VERSION) return null;
    const [, ephPubB64u, ivB64u, tagB64u, ctB64u] = parts as [string, string, string, string, string];
    const ephPub = createPublicKey({
      key: Buffer.from(ephPubB64u, "base64url"),
      format: "der",
      type: "spki",
    });
    const devicePriv = createPrivateKey({ key: devicePrivateKeyPem, format: "pem", type: "pkcs8" });
    const shared = diffieHellman({ privateKey: devicePriv, publicKey: ephPub });
    const key = deriveKey(shared, expected.planId);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(ivB64u, "base64url"));
    decipher.setAAD(aad(expected.planId, expected.upstreamId, expected.keyId));
    decipher.setAuthTag(Buffer.from(tagB64u, "base64url"));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(ctB64u, "base64url")),
      decipher.final(),
    ]);
    const payload = JSON.parse(plain.toString("utf8")) as LeasePayload;
    if (
      payload?.v !== 1 ||
      payload.planId !== expected.planId ||
      payload.upstreamId !== expected.upstreamId ||
      payload.keyId !== expected.keyId ||
      typeof payload.apiKey !== "string" ||
      typeof payload.url !== "string" ||
      typeof payload.expiresAt !== "number"
    ) {
      return null;
    }
    return payload;
  } catch {
    return null;
  }
}

/** lease 是否已过期（允许 ±120s 时钟漂移） */
export function isLeaseExpired(payload: LeasePayload, now: number = Date.now()): boolean {
  return payload.expiresAt + LEASE_CLOCK_SKEW_MS < now;
}

/** 生成 relay 侧的持久设备密钥对（PKCS8 PEM + SPKI DER base64url） */
export function generateDeviceKeypair(): { privateKeyPem: string; publicKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    privateKeyPem: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    publicKey: exportX25519PublicKey(publicKey),
  };
}
