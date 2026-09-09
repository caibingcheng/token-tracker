import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { GET as usageGET } from "./[id]/usage/route";
import { DELETE } from "./[id]/route";
import { db, initDatabase, virtualKeysTable, tokenRecords } from "@/lib/db";
import { setAdminApiKey, getTokenEpoch, deleteSetting } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-vk-route-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
});

beforeEach(async () => {
  await initDatabase();
  await withSkipCache(async () => {
    await db.delete(tokenRecords);
    await db.delete(virtualKeysTable);
  });
  await deleteSetting("token_epoch").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, method: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": token ?? "" },
  });
}

async function insertVk(overrides: Partial<Record<string, unknown>> = {}): Promise<any> {
  return withSkipCache(async () => {
    const row = await db
      .insert(virtualKeysTable)
      .values({
        name: (overrides.name as string) ?? "vk-a",
        apiKeyEncrypted: encryptSecret("vk-" + ((overrides.name as string) ?? "a")),
        enabled: 1,
        enabledModels: '["*"]',
        maxRpm: (overrides.maxRpm as number | null) ?? null,
        maxTpm: (overrides.maxTpm as number | null) ?? null,
        maxDailyTokens: (overrides.maxDailyTokens as number | null) ?? null,
        maxMonthlyTokens: (overrides.maxMonthlyTokens as number | null) ?? null,
      })
      .returning();
    return row[0];
  });
}

async function insertRecord(
  vkId: number,
  at: string,
  t: { i: number; o: number; cr: number; cw: number }
): Promise<void> {
  await withSkipCache(async () => {
    await db.insert(tokenRecords).values({
      model: "gpt-4o",
      provider: "p",
      agent: "a",
      inputTokens: t.i,
      outputTokens: t.o,
      cacheRead: t.cr,
      cacheWrite: t.cw,
      virtualKeyId: vkId,
      createdAt: at,
    });
  });
}

const tokens = (r: { i: number; o: number; cr: number; cw: number }) => r.i + r.o + r.cr + r.cw;

describe("virtual-keys admin routes - quotaUsage", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await GET(req("/api/admin/virtual-keys", "GET"));
    expect(res.status).toBe(401);
  });

  it("GET: unlimited vk returns quotaUsage null (no window queries)", async () => {
    await insertVk({ name: "unlimited-vk" });
    const token = await makeToken();
    const res = await GET(req("/api/admin/virtual-keys", "GET", token));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data[0].quotaUsage).toBeNull();
  });

  it("GET: limited vk returns correct window quotaUsage", async () => {
    const vk = await insertVk({ name: "limited-vk", maxRpm: 10, maxMonthlyTokens: 1_000_000 });
    const now = new Date();
    const sixtyAgo = new Date(now.getTime() - 60_000).toISOString();
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();

    const records = [
      { at: new Date(now.getTime() - 10_000).toISOString(), t: { i: 10, o: 5, cr: 2, cw: 1 } }, // 60s 窗内
      { at: new Date(now.getTime() - 5 * 60_000).toISOString(), t: { i: 20, o: 10, cr: 4, cw: 2 } }, // 日内非窗
      { at: new Date(now.getTime() - 24 * 3600_000).toISOString(), t: { i: 40, o: 20, cr: 8, cw: 4 } }, // 月内非日
    ];
    for (const r of records) {
      await insertRecord(vk.id, r.at, r.t);
    }

    const token = await makeToken();
    const res = await GET(req("/api/admin/virtual-keys", "GET", token));
    const data = await res.json();
    const row = data.data.find((r: any) => r.id === vk.id);
    expect(row.quotaUsage).not.toBeNull();

    const windowRecords = records.filter((r) => r.at >= sixtyAgo);
    expect(row.quotaUsage.rpm).toBe(windowRecords.length);
    expect(row.quotaUsage.tpm).toBe(windowRecords.reduce((acc, r) => acc + tokens(r.t), 0));
    expect(row.quotaUsage.dailyTokens).toBe(
      records.filter((r) => r.at >= dayStart).reduce((acc, r) => acc + tokens(r.t), 0)
    );
    expect(row.quotaUsage.monthlyTokens).toBe(
      records.filter((r) => r.at >= monthStart).reduce((acc, r) => acc + tokens(r.t), 0)
    );
  });

  it("usage detail: unlimited vk returns quotaUsage null", async () => {
    const vk = await insertVk({ name: "unlimited-detail" });
    const token = await makeToken();
    const res = await usageGET(req(`/api/admin/virtual-keys/${vk.id}/usage`, "GET", token), {
      params: { id: String(vk.id) },
    } as any);
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.data.quotaUsage).toBeNull();
  });

  it("usage detail: limited vk returns window quotaUsage", async () => {
    const vk = await insertVk({ name: "limited-detail", maxRpm: 10 });
    const now = new Date();
    const inWindow = { t: { i: 10, o: 5, cr: 2, cw: 1 } };
    await insertRecord(vk.id, new Date(now.getTime() - 10_000).toISOString(), inWindow.t);
    await insertRecord(vk.id, new Date(now.getTime() - 5 * 60_000).toISOString(), { i: 20, o: 10, cr: 4, cw: 2 });

    const token = await makeToken();
    const res = await usageGET(req(`/api/admin/virtual-keys/${vk.id}/usage`, "GET", token), {
      params: { id: String(vk.id) },
    } as any);
    const data = await res.json();
    expect(data.data.quotaUsage).not.toBeNull();
    expect(data.data.quotaUsage.rpm).toBe(1);
    expect(data.data.quotaUsage.tpm).toBe(tokens(inWindow.t));
  });

  it("GET: undecryptable row is flagged and does not break the list", async () => {
    const good = await insertVk({ name: "good-vk" });
    await withSkipCache(async () => {
      await db.insert(virtualKeysTable).values({
        name: "broken-vk",
        apiKeyEncrypted: "corrupted:not:valid:payload",
        enabled: 1,
        enabledModels: '["*"]',
      });
    });
    const token = await makeToken();
    const res = await GET(req("/api/admin/virtual-keys", "GET", token));
    expect(res.status).toBe(200);
    const data = await res.json();
    const goodRow = data.data.find((r: any) => r.id === good.id);
    const brokenRow = data.data.find((r: any) => r.name === "broken-vk");
    expect(goodRow.decryptFailed).toBe(false);
    expect(goodRow.apiKey).toMatch(/^vk-/);
    expect(brokenRow.decryptFailed).toBe(true);
    expect(brokenRow.apiKey).toBeNull();
  });

  it("DELETE: undecryptable row can still be deleted", async () => {
    await withSkipCache(async () => {
      const row = await db
        .insert(virtualKeysTable)
        .values({
          name: "broken-vk-2",
          apiKeyEncrypted: "corrupted:not:valid:payload",
          enabled: 1,
          enabledModels: '["*"]',
        })
        .returning();
      const token = await makeToken();
      const res = await DELETE(req(`/api/admin/virtual-keys/${row[0].id}`, "DELETE", token), {
        params: { id: String(row[0].id) },
      } as any);
      expect(res.status).toBe(200);
      const list = await GET(req("/api/admin/virtual-keys", "GET", token));
      const data = await list.json();
      expect(data.data.find((r: any) => r.id === row[0].id)).toBeUndefined();
    });
  });
});
