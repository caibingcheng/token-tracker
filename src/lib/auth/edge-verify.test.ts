import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createHmac, createHash } from "crypto";
import {
  deriveEdgeSessionKey,
  verifyEdgeSignature,
  parseEdgeSessionPayload,
  decodeBase64Url,
} from "./edge-verify";

const SECRET = "0123456789abcdef0123456789abcdef";

function nodeSign(payloadB64: string): string {
  const key = createHash("sha256").update(`${SECRET}:session-token`).digest();
  return createHmac("sha256", key).update(payloadB64).digest("base64url");
}

function makeToken(payload: object): string {
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${payloadB64}.${nodeSign(payloadB64)}`;
}

describe("edge verify (WebCrypto)", () => {
  it("verifies a signature produced by node:crypto side", async () => {
    const key = await deriveEdgeSessionKey(SECRET);
    const token = makeToken({ exp: Date.now() + 60_000, epoch: 0, keyId: "x" });
    const [payload, sig] = token.split(".");
    expect(await verifyEdgeSignature(key, payload!, sig!)).toBe(true);
  });

  it("rejects tampered signatures", async () => {
    const key = await deriveEdgeSessionKey(SECRET);
    const token = makeToken({ exp: Date.now() + 60_000, epoch: 0, keyId: "x" });
    const [payload, sig] = token.split(".");
    const tampered = sig!.endsWith("aa") ? sig!.slice(0, -2) + "bb" : sig!.slice(0, -2) + "aa";
    expect(await verifyEdgeSignature(key, payload!, tampered)).toBe(false);
  });

  it("rejects invalid base64 signatures", async () => {
    const key = await deriveEdgeSessionKey(SECRET);
    expect(await verifyEdgeSignature(key, "payload", "!!invalid!!")).toBe(false);
  });

  it("rejects tokens signed with a different secret", async () => {
    const key = await deriveEdgeSessionKey("ffffffffffffffffffffffffffffffff");
    const token = makeToken({ exp: Date.now() + 60_000, epoch: 0, keyId: "x" });
    const [payload, sig] = token.split(".");
    expect(await verifyEdgeSignature(key, payload!, sig!)).toBe(false);
  });

  it("accepts unexpired payloads and rejects expired ones", () => {
    const fresh = makeToken({ exp: Date.now() + 60_000, epoch: 0, keyId: "x" });
    expect(parseEdgeSessionPayload(fresh.split(".")[0]!)).not.toBeNull();

    const expired = makeToken({ exp: Date.now() - 1000, epoch: 0, keyId: "x" });
    expect(parseEdgeSessionPayload(expired.split(".")[0]!)).toBeNull();

    const garbage = Buffer.from("{not json").toString("base64url");
    expect(parseEdgeSessionPayload(garbage)).toBeNull();
  });

  it("decodeBase64Url handles standard base64url padding rules", () => {
    expect(decodeBase64Url("SGVsbG8")).not.toBeNull();
    expect(new TextDecoder().decode(decodeBase64Url("SGVsbG8"))).toBe("Hello");
    expect(decodeBase64Url("!!!")).toBeNull();
  });
});
