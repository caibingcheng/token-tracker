import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;

export class GatewaySecretMissingError extends Error {
  constructor() {
    super(
      "GATEWAY_SECRET environment variable is required (AES-256-GCM master key, hex/base64 encoded 32 bytes)"
    );
    this.name = "GatewaySecretMissingError";
  }
}

export class GatewayCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GatewayCryptoError";
  }
}

function isHex32Bytes(input: string): boolean {
  return /^[0-9a-fA-F]{64}$/.test(input);
}

function deriveKey(secret: string): Buffer {
  if (isHex32Bytes(secret)) {
    return Buffer.from(secret, "hex");
  }
  try {
    const decoded = Buffer.from(secret, "base64");
    if (decoded.length === 32) {
      return decoded;
    }
  } catch {
    // fall through to hash derivation
  }
  return createHash("sha256").update(secret).digest();
}

export function getGatewaySecretKey(): Buffer {
  const secret = process.env.GATEWAY_SECRET;
  if (!secret) {
    throw new GatewaySecretMissingError();
  }
  return deriveKey(secret);
}

export function encryptSecret(plain: string): string {
  const key = getGatewaySecretKey();
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return `${iv.toString("base64")}:${authTag.toString("base64")}:${encrypted.toString("base64")}`;
}

export function decryptSecret(encrypted: string): string {
  const key = getGatewaySecretKey();
  const parts = encrypted.split(":");
  if (parts.length !== 3) {
    throw new GatewayCryptoError("Invalid encrypted payload format");
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64!, "base64");
  const authTag = Buffer.from(authTagB64!, "base64");
  const ciphertext = Buffer.from(ciphertextB64!, "base64");
  if (iv.length !== IV_LENGTH) {
    throw new GatewayCryptoError("Invalid IV length");
  }
  if (authTag.length !== AUTH_TAG_LENGTH) {
    throw new GatewayCryptoError("Invalid auth tag length");
  }
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
  } catch {
    throw new GatewayCryptoError("Decryption failed (wrong key or tampered ciphertext)");
  }
}

export function generateVirtualKey(): string {
  return `vk-${randomBytes(24).toString("base64url")}`;
}

export function generateSecret(): string {
  return randomBytes(32).toString("hex");
}

export function safeCompare(a: string, b: string): boolean {
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}
