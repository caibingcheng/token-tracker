// withDeviceAuth：有效 token 放行 / revoked 401 / 未知 token 401 / last_seen_at 异步刷新
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { withDeviceAuth } from "./device-guard";
import { db, closeDb, devicesTable, initDatabase } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { deviceTokenHash, generateDeviceToken } from "@/lib/device/pairing";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-devicetoken-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
  await initDatabase();
  await withSkipCache(async () => {
    await db.delete(devicesTable);
  });
});

async function seedDevice(over: Partial<{ revokedAt: string | null; token: string }> = {}) {
  const token = over.token ?? generateDeviceToken();
  await withSkipCache(async () => {
    await db.insert(devicesTable).values({
      fingerprint: `u-${"a".repeat(32)}`,
      name: "laptop",
      publicKey: "pub",
      tokenHash: deviceTokenHash(token),
      createdAt: new Date().toISOString(),
      revokedAt: over.revokedAt ?? null,
    });
  });
  return token;
}

function req(token?: string): NextRequest {
  return new NextRequest("http://localhost/api/device/plan", {
    method: "POST",
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

const handler = withDeviceAuth(async (_request, device) =>
  NextResponse.json({ ok: true, id: device.id, fingerprint: device.fingerprint })
);

describe("withDeviceAuth", () => {
  it("有效 token 放行并注入 device 上下文", async () => {
    const token = await seedDevice();
    const res = await handler(req(token));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { ok: boolean; fingerprint: string };
    expect(body.ok).toBe(true);
    expect(body.fingerprint).toBe(`u-${"a".repeat(32)}`);
  });

  it("缺 header / 形状不符 → 401（不查库）", async () => {
    expect((await handler(req())).status).toBe(401);
    expect((await handler(req("sk-not-a-device-token"))).status).toBe(401);
    expect((await handler(req("dt-" + "a".repeat(30)))).status).toBe(401);
  });

  it("未知 token → 401", async () => {
    await seedDevice();
    expect((await handler(req(generateDeviceToken()))).status).toBe(401);
  });

  it("已撤销 → 401（每次直读 DB，不进查询缓存）", async () => {
    const token = await seedDevice({ revokedAt: new Date().toISOString() });
    const res = await handler(req(token));
    expect(res.status).toBe(401);
    expect(((await res.json()) as { error: string }).error).toContain("Invalid or revoked");
  });

  it("last_seen_at 异步刷新（不阻塞响应）", async () => {
    const token = await seedDevice();
    expect((await handler(req(token))).status).toBe(200);
    // fire-and-forget：给它一个 event loop 轮次落库
    await new Promise((r) => setTimeout(r, 30));
    const row = await withSkipCache(async () => {
      const rows = await db.select().from(devicesTable).where(eq(devicesTable.name, "laptop"));
      return rows[0];
    });
    expect(row?.lastSeenAt).toBeTruthy();
  });
});
