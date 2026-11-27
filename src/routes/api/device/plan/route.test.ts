// /api/device/plan 集成测试（临时 SQLite + 真实 handler + 真实 device token）
// 覆盖：vk 无效 401 / allowlist 403 / 配额 429 / 版本过低 426 / 正常 plan 的 lease 可解且与 deps 一致
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { POST } from "./route";
import {
  closeDb,
  db,
  devicePlansTable,
  devicesTable,
  initDatabase,
  upstreamKeysTable,
  upstreamsTable,
  virtualKeysTable,
} from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";
import { virtualKeyFingerprint } from "@/lib/gateway/vk-fingerprint";
import { deviceTokenHash, generateDeviceToken } from "@/lib/device/pairing";
import { generateDeviceKeypair, openLease } from "@/lib/gateway/lease";
import type { LeasePayload } from "@/lib/gateway/lease";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
let dir: string;

const VK_PLAIN = "vk-relay-test-key";

interface Seeded {
  token: string;
  privateKeyPem: string;
  deviceId: number;
  vkId: number;
  upstreamId: number;
  keyId: number;
}

async function seed(over: {
  enabledModels?: string;
  maxRpm?: number | null;
  maxTpm?: number | null;
  headerTransforms?: string | null;
} = {}): Promise<Seeded> {
  const keypair = generateDeviceKeypair();
  const token = generateDeviceToken();
  return withSkipCache(async () => {
    const device = await db
      .insert(devicesTable)
      .values({
        fingerprint: `u-${"b".repeat(32)}`,
        name: "laptop",
        publicKey: keypair.publicKey,
        tokenHash: deviceTokenHash(token),
        createdAt: new Date().toISOString(),
      })
      .returning({ id: devicesTable.id });
    const vk = await db
      .insert(virtualKeysTable)
      .values({
        name: "vk-main",
        apiKeyEncrypted: encryptSecret(VK_PLAIN),
        enabledModels: over.enabledModels ?? '["*"]',
        maxRpm: over.maxRpm ?? null,
        maxTpm: over.maxTpm ?? null,
        keyFingerprint: virtualKeyFingerprint(VK_PLAIN),
        createdAt: new Date().toISOString(),
      })
      .returning({ id: virtualKeysTable.id });
    const upstream = await db
      .insert(upstreamsTable)
      .values({
        name: "u1",
        protocol: "openai",
        baseUrl: "https://u1.example.com/v1",
        enabledModels: '["gpt-a"]',
        priority: 1,
        enabled: 1,
        headerTransforms: over.headerTransforms ?? null,
      })
      .returning({ id: upstreamsTable.id });
    const key = await db
      .insert(upstreamKeysTable)
      .values({
        upstreamId: Number(upstream[0]!.id),
        apiKeyEncrypted: encryptSecret("sk-upstream-1"),
        enabled: 1,
      })
      .returning({ id: upstreamKeysTable.id });
    return {
      token,
      privateKeyPem: keypair.privateKeyPem,
      deviceId: Number(device[0]!.id),
      vkId: Number(vk[0]!.id),
      upstreamId: Number(upstream[0]!.id),
      keyId: Number(key[0]!.id),
    };
  });
}

function planRequest(token: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/device/plan", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

function chatPlan(over: Record<string, unknown> = {}) {
  return {
    vkFp: virtualKeyFingerprint(VK_PLAIN),
    path: "/v1/chat/completions",
    model: "gpt-a",
    protocol: "openai",
    stream: false,
    hasMessages: true,
    sessionInput: "syshi",
    userAgent: "agent/1.0",
    relayVersion: "1.0.0",
    estimatedInputTokens: 1234,
    ...over,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-deviceplan-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
});

beforeEach(async () => {
  await initDatabase();
  await withSkipCache(async () => {
    await db.delete(devicePlansTable);
    await db.delete(upstreamKeysTable);
    await db.delete(upstreamsTable);
    await db.delete(virtualKeysTable);
    await db.delete(devicesTable);
  });
});

describe("POST /api/device/plan", () => {
  it("device token 缺失/无效 → 401", async () => {
    const seeded = await seed();
    const res = await POST(planRequest("dt-" + "c".repeat(32), chatPlan()));
    expect(res.status).toBe(401);
    // 有效 token 但 vk 指纹不存在 → 401 invalid_api_key
    const badVk = await POST(planRequest(seeded.token, chatPlan({ vkFp: "f".repeat(64) })));
    expect(badVk.status).toBe(401);
    expect(((await badVk.json()) as any).error.type).toBe("invalid_api_key");
  });

  it("relay 版本过低 → 426 relay_too_old", async () => {
    const seeded = await seed();
    const res = await POST(planRequest(seeded.token, chatPlan({ relayVersion: "0.9.9" })));
    expect(res.status).toBe(426);
    expect(((await res.json()) as any).error.type).toBe("relay_too_old");
  });

  it("vk allowlist 不含该 model → 403 model_not_allowed", async () => {
    const seeded = await seed({ enabledModels: '["other-*"]' });
    const res = await POST(planRequest(seeded.token, chatPlan()));
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.type).toBe("model_not_allowed");
  });

  it("超过 rpm 配额 → 429 quota_exceeded", async () => {
    const seeded = await seed({ maxRpm: 0 });
    const res = await POST(planRequest(seeded.token, chatPlan()));
    expect(res.status).toBe(429);
    expect(((await res.json()) as any).error.type).toBe("quota_exceeded");
  });

  it("model 不存在 → 404 model_not_found", async () => {
    const seeded = await seed();
    const res = await POST(planRequest(seeded.token, chatPlan({ model: "nope" })));
    expect(res.status).toBe(404);
    expect(((await res.json()) as any).error.type).toBe("model_not_found");
  });

  it("正常 plan：hop 序列 / lease 可解 / 落库素材与配额预留", async () => {
    const seeded = await seed({ maxTpm: 1_000_000 });
    const res = await POST(planRequest(seeded.token, chatPlan()));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(typeof body.planId).toBe("string");
    expect(body.hops).toHaveLength(1);
    expect(body.hops[0]).toMatchObject({
      upstreamId: seeded.upstreamId,
      keyId: seeded.keyId,
      realModel: "gpt-a",
      retries: 2,
      timeoutMs: 60_000,
      passthrough: "last-4xx",
      suppressHealth: [],
    });
    expect(body.hops[0].continueOn).toContain("404");
    expect(body.quota).toEqual({ reservedTokens: 1234, reservedRpm: 1 });
    expect(body.policy.centerMaxBodyMb).toBeGreaterThan(0);
    // 中心设备名随 plan 下发（relay 用它展示；改名靠这条链路同步，不需要心跳）
    expect(body.device).toEqual({ id: seeded.deviceId, name: "laptop" });

    // lease：用设备私钥解开，AAD 绑定 planId|upstreamId|keyId，URL 与 hop 一致
    const lease = openLease(body.hops[0].keyLease, seeded.privateKeyPem, {
      planId: body.planId,
      upstreamId: seeded.upstreamId,
      keyId: seeded.keyId,
    }) as LeasePayload | null;
    expect(lease).not.toBeNull();
    expect(lease!.apiKey).toBe("sk-upstream-1");
    expect(lease!.url).toBe("https://u1.example.com/v1/chat/completions");
    expect(lease!.protocol).toBe("openai");
    expect(lease!.expiresAt).toBe(body.hops[0].leaseExpiresAt);

    // 落库素材：report 侧只能回报 hopIndex，其余以这里为准
    const row = await withSkipCache(async () => {
      const rows = await db
        .select()
        .from(devicePlansTable)
        .where(eq(devicePlansTable.planId, body.planId));
      return rows[0];
    });
    expect(row).toMatchObject({
      deviceId: seeded.deviceId,
      virtualKeyId: seeded.vkId,
      mode: "router",
      protocol: "openai",
      requestModel: "gpt-a",
      userAgent: "agent/1.0",
      reservedTokens: 1234,
      reservedRpm: 1,
      status: null,
    });
    expect(JSON.parse(row!.hopsJson!)).toEqual([
      { hopIndex: 0, upstreamId: seeded.upstreamId, keyId: seeded.keyId, realModel: "gpt-a" },
    ]);
    expect(row!.recordSessionId).toMatch(/^[0-9a-f]{64}$/);
  });

  it("models 模式：返回快照、无 hop、reservedRpm=0", async () => {
    const seeded = await seed();
    const res = await POST(
      planRequest(seeded.token, chatPlan({ path: "/v1/models", model: null }))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.hops).toEqual([]);
    expect(body.modelsSnapshot).toContain("gpt-a");
    expect(body.quota).toEqual({ reservedTokens: 0, reservedRpm: 0 });
  });

  it("header transforms 在中心求值：fill 按 relay 上报的 header 名判定，override 含空值都要下发", async () => {
    const seeded = await seed({
      headerTransforms: JSON.stringify([
        { id: "ht-1", header: "x-fill", value: "filled", mode: "fill", enabled: true },
        { id: "ht-2", header: "x-clear", value: "", mode: "override", enabled: true },
        { id: "ht-3", header: "x-sess", value: "${var.sessionId}", mode: "override", enabled: true },
      ]),
    });
    // 客户端已带 x-fill → fill 跳过；x-clear 是显式置空（合法值），必须原样进 lease
    const res = await POST(
      planRequest(seeded.token, chatPlan({ headerNames: ["x-fill", "authorization"] }))
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const lease = openLease(body.hops[0].keyLease, seeded.privateKeyPem, {
      planId: body.planId,
      upstreamId: seeded.upstreamId,
      keyId: seeded.keyId,
    }) as LeasePayload | null;
    expect(lease).not.toBeNull();
    expect(lease!.headers).toEqual({ "x-clear": "", "x-sess": expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(lease!.headers).not.toHaveProperty("x-fill");
  });

  it("body 超过 8KB → 413", async () => {
    const seeded = await seed();
    const huge = chatPlan({ sessionInput: "x".repeat(9000) });
    const res = await POST(planRequest(seeded.token, huge));
    expect(res.status).toBe(413);
  });
});
