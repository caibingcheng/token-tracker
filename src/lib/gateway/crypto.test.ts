import { describe, it, expect, beforeEach } from "vitest";
import {
  encryptSecret,
  decryptSecret,
  generateVirtualKey,
  generateSecret,
  GatewaySecretMissingError,
  GatewayCryptoError,
} from "./crypto";

const VALID_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

describe("gateway crypto", () => {
  beforeEach(() => {
    delete process.env.GATEWAY_SECRET;
  });

  it("throws GatewaySecretMissingError when GATEWAY_SECRET is missing", () => {
    expect(() => encryptSecret("hello")).toThrow(GatewaySecretMissingError);
    expect(() => decryptSecret("a:b:c")).toThrow(GatewaySecretMissingError);
  });

  it("encrypts and decrypts round-trip with hex secret", () => {
    process.env.GATEWAY_SECRET = VALID_HEX;
    const encrypted = encryptSecret("sk-test-123");
    expect(encrypted).not.toContain("sk-test-123");
    expect(decryptSecret(encrypted)).toBe("sk-test-123");
  });

  it("supports base64 encoded 32-byte secret", () => {
    process.env.GATEWAY_SECRET = Buffer.alloc(32, 7).toString("base64");
    const encrypted = encryptSecret("secret-value");
    expect(decryptSecret(encrypted)).toBe("secret-value");
  });

  it("derives key via sha256 for arbitrary length secret", () => {
    process.env.GATEWAY_SECRET = "any-arbitrary-passphrase";
    const encrypted = encryptSecret("x");
    expect(decryptSecret(encrypted)).toBe("x");
  });

  it("produces different ciphertext per encryption (random IV)", () => {
    process.env.GATEWAY_SECRET = VALID_HEX;
    const a = encryptSecret("same");
    const b = encryptSecret("same");
    expect(a).not.toBe(b);
    expect(decryptSecret(a)).toBe("same");
    expect(decryptSecret(b)).toBe("same");
  });

  it("fails to decrypt with wrong key", () => {
    process.env.GATEWAY_SECRET = VALID_HEX;
    const encrypted = encryptSecret("hello");
    process.env.GATEWAY_SECRET = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    expect(() => decryptSecret(encrypted)).toThrow(GatewayCryptoError);
  });

  it("fails on tampered ciphertext", () => {
    process.env.GATEWAY_SECRET = VALID_HEX;
    const encrypted = encryptSecret("hello");
    const parts = encrypted.split(":");
    const buf = Buffer.from(parts[2]!, "base64");
    buf[0] = buf[0]! ^ 0xff;
    const tampered = `${parts[0]}:${parts[1]}:${buf.toString("base64")}`;
    expect(() => decryptSecret(tampered)).toThrow(GatewayCryptoError);
  });

  it("rejects malformed payload", () => {
    process.env.GATEWAY_SECRET = VALID_HEX;
    expect(() => decryptSecret("not-a-valid-format")).toThrow(GatewayCryptoError);
    expect(() => decryptSecret("abc:def")).toThrow(GatewayCryptoError);
  });

  it("generateVirtualKey returns vk- prefixed 32+ char key", () => {
    const key = generateVirtualKey();
    expect(key.startsWith("vk-")).toBe(true);
    expect(key.length).toBeGreaterThan(30);
    const another = generateVirtualKey();
    expect(another).not.toBe(key);
  });

  it("generateSecret returns 64 hex chars", () => {
    expect(generateSecret()).toMatch(/^[0-9a-f]{64}$/);
  });
});
