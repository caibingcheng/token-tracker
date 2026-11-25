import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { NextRequest, NextResponse } from "next/server";
import { withAuth, resolveActiveKeyId } from "./guard";
import {
  signSessionToken,
  verifySessionToken,
  keyFingerprint,
  legacyKeyFingerprint,
} from "./session";

// settings 整模块 mock：resolveActiveKeyId / withAuth 只用到这四个读函数，
// 真实实现会开 SQLite，单测不需要
const ADMIN_KEY = "test-admin-key";
vi.mock("./settings", () => ({
  getAdminApiKey: vi.fn(async () => ADMIN_KEY),
  getEnvAdminKeys: vi.fn(async () => []),
  getTokenEpoch: vi.fn(async () => 7),
  resolveSessionTtlMs: vi.fn(async () => 60 * 60 * 1000),
}));

const ORIGINAL_SECRET = process.env.GATEWAY_SECRET;

beforeEach(() => {
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterEach(() => {
  if (ORIGINAL_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIGINAL_SECRET;
});

const handler = withAuth(async () => NextResponse.json({ ok: true }));

function requestWithToken(token: string): NextRequest {
  return new NextRequest("http://localhost/api/test", {
    method: "GET",
    headers: { "X-API-Key": token },
  });
}

const ctx = { params: Promise.resolve<Record<string, string>>({}) };

describe("resolveActiveKeyId", () => {
  it("新格式 keyId 命中：原样返回", async () => {
    const fresh = keyFingerprint(ADMIN_KEY);
    expect(await resolveActiveKeyId(fresh)).toBe(fresh);
  });

  it("legacy（裸 sha256）keyId 命中：返回新格式指纹（静默轮换）", async () => {
    const legacy = legacyKeyFingerprint(ADMIN_KEY);
    const resolved = await resolveActiveKeyId(legacy);
    expect(resolved).toBe(keyFingerprint(ADMIN_KEY));
    expect(resolved).not.toBe(legacy);
  });

  it("不匹配任何候选 key：null", async () => {
    expect(await resolveActiveKeyId("deadbeef")).toBeNull();
  });
});

describe("withAuth 静默轮换", () => {
  it("legacy token 放行并通过 X-Session-Token 换发新格式 keyId", async () => {
    const legacyToken = signSessionToken(7, legacyKeyFingerprint(ADMIN_KEY));
    const res = await handler(requestWithToken(legacyToken), ctx);
    expect(res.status).toBe(200);

    const renewed = res.headers.get("X-Session-Token");
    expect(renewed).not.toBeNull();
    const payload = verifySessionToken(renewed!);
    expect(payload).not.toBeNull();
    expect(payload!.keyId).toBe(keyFingerprint(ADMIN_KEY));
  });

  it("换发的新 token 再次通过认证（轮换后闭环）", async () => {
    const legacyToken = signSessionToken(7, legacyKeyFingerprint(ADMIN_KEY));
    const first = await handler(requestWithToken(legacyToken), ctx);
    const upgraded = first.headers.get("X-Session-Token")!;
    const second = await handler(requestWithToken(upgraded), ctx);
    expect(second.status).toBe(200);
    // 已是新格式且剩余有效期充足：不再续期
    expect(second.headers.get("X-Session-Token")).toBeNull();
  });

  it("新格式 token（未到续期线）正常放行且不续期", async () => {
    const token = signSessionToken(7, keyFingerprint(ADMIN_KEY));
    const res = await handler(requestWithToken(token), ctx);
    expect(res.status).toBe(200);
    expect(res.headers.get("X-Session-Token")).toBeNull();
  });

  it("未知 keyId → 401", async () => {
    const token = signSessionToken(7, "not-a-valid-fingerprint");
    const res = await handler(requestWithToken(token), ctx);
    expect(res.status).toBe(401);
  });

  it("epoch 不匹配 → 401（legacy 放行不越过 epoch 吊销）", async () => {
    const token = signSessionToken(6, legacyKeyFingerprint(ADMIN_KEY));
    const res = await handler(requestWithToken(token), ctx);
    expect(res.status).toBe(401);
  });
});
