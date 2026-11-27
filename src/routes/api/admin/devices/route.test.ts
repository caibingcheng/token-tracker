// /api/admin/devices* 集成测试：列表状态与记录数、改名/撤销、轮换 token、删除（保留记录置空
// device_id）、统计块、未带会话 token 401、审计动作落库
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { GET as listDevices, POST as pairingAction } from "./route";
import { PATCH, DELETE } from "./[id]/route";
import { POST as rotateToken } from "./[id]/rotate-token/route";
import { GET as stats } from "./stats/route";
import { GET as pendingPairings } from "./pairings/route";
import {
  adminAuditLogsTable,
  closeDb,
  db,
  devicePairingsTable,
  devicePlansTable,
  devicesTable,
  initDatabase,
  tokenRecords,
  virtualKeysTable,
} from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { setAdminApiKey, getTokenEpoch } from "@/lib/auth/settings";
import { keyFingerprint, signSessionToken } from "@/lib/auth/session";
import { deviceTokenHash, generateDeviceToken } from "@/lib/device/pairing";
import { getDeviceByTokenHash, startPairing } from "@/lib/device/store";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
let dir: string;
const ADMIN_KEY = "test-admin-key-123456";

async function token(): Promise<string> {
  return signSessionToken(await getTokenEpoch(), keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, method: string, body?: unknown, sessionToken?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(sessionToken ? { "X-API-Key": sessionToken } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = (id: number) => ({ params: Promise.resolve({ id: String(id) }) });

async function seedDevice(name: string, over: { revokedAt?: string | null } = {}) {
  const deviceToken = generateDeviceToken();
  const rows = await withSkipCache(async () =>
    db
      .insert(devicesTable)
      .values({
        fingerprint: `u-${Math.random().toString(16).slice(2).padEnd(32, "0").slice(0, 32)}`,
        name,
        publicKey: "pub",
        tokenHash: deviceTokenHash(deviceToken),
        createdAt: new Date().toISOString(),
        revokedAt: over.revokedAt ?? null,
      })
      .returning({ id: devicesTable.id })
  );
  return { id: Number(rows[0]!.id), deviceToken };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-admindevices-"));
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
    await db.delete(devicePairingsTable);
    await db.delete(tokenRecords);
    await db.delete(devicesTable);
    await db.delete(virtualKeysTable);
    await db.delete(adminAuditLogsTable);
  });
  await setAdminApiKey(ADMIN_KEY);
});

async function audits() {
  return withSkipCache(async () => db.select().from(adminAuditLogsTable));
}

describe("/api/admin/devices", () => {
  it("未带会话 token → 401（列表/统计/改名/轮换/删除均如此）", async () => {
    const device = await seedDevice("laptop");
    expect((await listDevices(req("/api/admin/devices", "GET"))).status).toBe(401);
    expect((await stats(req("/api/admin/devices/stats", "GET"))).status).toBe(401);
    expect(
      (await PATCH(req(`/api/admin/devices/${device.id}`, "PATCH", { name: "x" }), ctx(device.id))).status
    ).toBe(401);
    expect(
      (await DELETE(req(`/api/admin/devices/${device.id}`, "DELETE"), ctx(device.id))).status
    ).toBe(401);
    expect(
      (await rotateToken(req(`/api/admin/devices/${device.id}/rotate-token`, "POST"), ctx(device.id)))
        .status
    ).toBe(401);
    expect((await pairingAction(req("/api/admin/devices", "POST", { code: "ABCD-EFGH" }))).status).toBe(
      401
    );
  });

  it("列表：状态派生 + 近 30 天记录数", async () => {
    const active = await seedDevice("laptop");
    const revoked = await seedDevice("old-box", { revokedAt: new Date().toISOString() });
    await withSkipCache(async () => {
      await db.insert(tokenRecords).values([
        { model: "gpt-a", provider: "u1", agent: "vk", deviceId: active.id },
        { model: "gpt-a", provider: "u1", agent: "vk", deviceId: active.id },
        { model: "gpt-a", provider: "u1", agent: "vk", deviceId: revoked.id },
        // 直连记录（device_id NULL）不计入任何设备
        { model: "gpt-a", provider: "u1", agent: "vk" },
      ]);
    });
    const sessionToken = await token();
    const res = await listDevices(req("/api/admin/devices", "GET", undefined, sessionToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    const byName = new Map(body.data.map((d: any) => [d.name, d]));
    expect(byName.get("laptop")).toMatchObject({ status: "active", recordCount30d: 2 });
    expect(byName.get("old-box")).toMatchObject({ status: "revoked", recordCount30d: 1 });
    // fingerprint 全文只在前端截断，这里仍返回完整值（管理面需要精确标识）
    expect(byName.get("laptop").fingerprint).toMatch(/^u-[0-9a-f]{32}$/);
  });

  it("改名 / 撤销 / 解除撤销：落库 + 审计", async () => {
    const device = await seedDevice("laptop");
    const sessionToken = await token();

    const renamed = await PATCH(
      req(`/api/admin/devices/${device.id}`, "PATCH", { name: "macbook" }, sessionToken),
      ctx(device.id)
    );
    expect(renamed.status).toBe(200);

    const revoked = await PATCH(
      req(`/api/admin/devices/${device.id}`, "PATCH", { revoked: true }, sessionToken),
      ctx(device.id)
    );
    expect(revoked.status).toBe(200);

    const unrevoked = await PATCH(
      req(`/api/admin/devices/${device.id}`, "PATCH", { revoked: false }, sessionToken),
      ctx(device.id)
    );
    expect(unrevoked.status).toBe(200);

    const rows = await audits();
    expect(rows.map((r: any) => r.action)).toEqual([
      "device_renamed",
      "device_revoked",
      "device_unrevoked",
    ]);
    expect(JSON.parse(rows[0]!.details!)).toEqual({ from: "laptop", to: "macbook" });
  });

  it("轮换 token：旧 token 立即失效，新 token 可用", async () => {
    const device = await seedDevice("laptop");
    const sessionToken = await token();
    const res = await rotateToken(
      req(`/api/admin/devices/${device.id}/rotate-token`, "POST", undefined, sessionToken),
      ctx(device.id)
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data.token).toMatch(/^dt-/);

    expect(await getDeviceByTokenHash(deviceTokenHash(device.deviceToken))).toBeNull();
    expect(await getDeviceByTokenHash(deviceTokenHash(body.data.token))).not.toBeNull();
    expect((await audits())[0]!.action).toBe("device_token_rotated");
  });

  it("删除设备：清 device_plans，token_records.device_id 置 NULL（记录保留）", async () => {
    const device = await seedDevice("laptop");
    const sessionToken = await token();
    await withSkipCache(async () => {
      await db.insert(tokenRecords).values({
        model: "gpt-a",
        provider: "u1",
        agent: "vk",
        deviceId: device.id,
      });
      await db.insert(devicePlansTable).values({
        planId: "plan-del",
        deviceId: device.id,
        hopsJson: "[]",
        mode: "router",
        protocol: "openai",
        createdAt: new Date().toISOString(),
        expiresAt: Date.now() + 60_000,
      });
    });

    const res = await DELETE(
      req(`/api/admin/devices/${device.id}`, "DELETE", undefined, sessionToken),
      ctx(device.id)
    );
    expect(res.status).toBe(200);

    const records = await withSkipCache(async () => db.select().from(tokenRecords));
    expect(records).toHaveLength(1);
    expect(records[0]!.deviceId).toBeNull();
    const plans = await withSkipCache(async () =>
      db.select().from(devicePlansTable).where(eq(devicePlansTable.deviceId, device.id))
    );
    expect(plans).toEqual([]);
    expect((await audits())[0]!.action).toBe("device_deleted");
  });

  it("待授权列表（pairingId）+ 列表里一键授权/拒绝（免手输码）", async () => {
    const sessionToken = await token();
    const base = {
      publicKey: "pub",
      clientSecret: "s".repeat(32),
      userAgent: "undici",
    };
    const first = await startPairing({
      ...base,
      fingerprint: `u-${"a".repeat(32)}`,
      name: "relay-a",
      clientIp: "10.9.0.1",
    });
    const second = await startPairing({
      ...base,
      fingerprint: `u-${"b".repeat(32)}`,
      name: "relay-b",
      clientIp: "10.9.0.2",
    });
    expect(first.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(second.code).not.toBe(first.code);

    // relay 一发起配对，管理面就能看到（不需要人去读日志里的码）
    const listRes = await pendingPairings(
      req("/api/admin/devices/pairings", "GET", undefined, sessionToken)
    );
    expect(listRes.status).toBe(200);
    const list = ((await listRes.json()) as any).data as { pairingId: string; name: string }[];
    expect(list).toHaveLength(2);
    expect(list[0]!.pairingId).toMatch(/^[0-9a-f]{64}$/);
    const byName = new Map(list.map((p) => [p.name, p.pairingId]));

    // 用 pairingId 授权（无需输码）
    const authorize = await pairingAction(
      req(
        "/api/admin/devices",
        "POST",
        { pairingId: byName.get("relay-a"), action: "authorize" },
        sessionToken
      )
    );
    expect(authorize.status).toBe(200);
    const devices = await withSkipCache(async () => db.select().from(devicesTable));
    expect(devices).toHaveLength(1);
    expect(devices[0]!.name).toBe("relay-a");
    // 授权后 token 还没被 poll 取走 → devices 行 token_hash 仍为 NULL（列表显示 pending）
    expect(devices[0]!.tokenHash).toBeNull();

    // 用 pairingId 拒绝
    const deny = await pairingAction(
      req(
        "/api/admin/devices",
        "POST",
        { pairingId: byName.get("relay-b"), action: "deny" },
        sessionToken
      )
    );
    expect(deny.status).toBe(200);
    const remaining = await pendingPairings(
      req("/api/admin/devices/pairings", "GET", undefined, sessionToken)
    );
    expect(((await remaining.json()) as any).data).toEqual([]);
    expect((await audits()).map((r: any) => r.action)).toEqual([
      "device_paired",
      "device_pairing_denied",
    ]);

    // 两者都不给 → 400
    const empty = await pairingAction(
      req("/api/admin/devices", "POST", { action: "authorize" }, sessionToken)
    );
    expect(empty.status).toBe(400);
  });

  it("统计块：设备数 / 活跃数 / plan 速率 / 预留泄漏", async () => {
    const active = await seedDevice("laptop");
    await seedDevice("old-box", { revokedAt: new Date().toISOString() });
    await withSkipCache(async () => {
      await db.insert(devicePlansTable).values([
        {
          planId: "plan-recent",
          deviceId: active.id,
          hopsJson: "[]",
          mode: "router",
          protocol: "openai",
          createdAt: new Date().toISOString(),
          expiresAt: Date.now() + 60_000,
        },
        {
          planId: "plan-leaked",
          deviceId: active.id,
          hopsJson: "[]",
          mode: "router",
          protocol: "openai",
          createdAt: new Date().toISOString(),
          expiresAt: Date.now() - 1000,
        },
      ]);
    });
    const sessionToken = await token();
    const res = await stats(req("/api/admin/devices/stats", "GET", undefined, sessionToken));
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.data).toMatchObject({
      devices: 2,
      activeDevices: 1,
      plansLastMinute: 2,
      reportsLastMinute: 0,
    });
    expect(body.data.relayGapCount).toBeGreaterThanOrEqual(1);
  });
});
