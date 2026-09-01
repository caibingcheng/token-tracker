import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { sql } from "drizzle-orm";
import { DELETE } from "./route";
import {
  db,
  initDatabase,
  tokenRecords,
  syncInstancesTable,
  adminAuditLogsTable,
} from "@/lib/db";
import { setAdminApiKey, getTokenEpoch, deleteSetting } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-sync-instances-route-"));
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
    await db.delete(syncInstancesTable);
    await db.delete(adminAuditLogsTable);
  });
  await deleteSetting("token_epoch").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function delReq(url: string, token: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "DELETE",
    headers: { "x-api-key": token },
  });
}

async function insertInstance(instance: string, lastRecordId: number): Promise<void> {
  await withSkipCache(async () => {
    await db.insert(syncInstancesTable).values({
      instance,
      epoch: `epoch-${instance}`,
      lastRecordId,
    });
  });
}

async function insertRecord(
  provider: string,
  virtualKeyId: number | null
): Promise<void> {
  await withSkipCache(async () => {
    await db.insert(tokenRecords).values({
      model: "gpt-4o",
      provider,
      agent: "claude-code",
      inputTokens: 10,
      outputTokens: 5,
      cacheRead: 0,
      cacheWrite: 0,
      virtualKeyId,
      createdAt: "2026-09-01T10:00:00.000Z",
    });
  });
}

async function countRecords(): Promise<number> {
  return withSkipCache(async () => {
    const rows = await db.select().from(tokenRecords);
    return rows.length;
  });
}

async function countForProvider(provider: string): Promise<number> {
  return withSkipCache(async () => {
    const rows = await db
      .select()
      .from(tokenRecords)
      .where(sql`${tokenRecords.provider} LIKE ${provider}`);
    return rows.length;
  });
}

async function getAuditActions(): Promise<string[]> {
  return withSkipCache(async () => {
    const rows = await db.select().from(adminAuditLogsTable);
    return rows.map((r: any) => r.details ?? "");
  });
}

describe("DELETE /api/admin/sync-instances/[instance]", () => {
  it("rejects invalid instance name with 400", async () => {
    const token = await makeToken();
    const res = await DELETE(delReq("/api/admin/sync-instances/../evil", token), {
      params: { instance: ".." },
    });
    expect(res.status).toBe(400);
  });

  it("returns 404 and leaves records untouched when watermark missing", async () => {
    await insertRecord("remote/nonexistent/openai", -1);
    const token = await makeToken();
    const res = await DELETE(
      delReq("/api/admin/sync-instances/nonexistent?deleteRecords=1", token),
      { params: { instance: "nonexistent" } }
    );
    expect(res.status).toBe(404);
    expect(await countRecords()).toBe(1);
  });

  it("default DELETE removes only the watermark, keeps all records", async () => {
    await insertInstance("bing-mbp", 42);
    await insertRecord("remote/bing-mbp/openai", -1);
    const token = await makeToken();
    const res = await DELETE(delReq("/api/admin/sync-instances/bing-mbp", token), {
      params: { instance: "bing-mbp" },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.deletedRecords).toBe(0);

    expect(await countRecords()).toBe(1);
    const wm = await withSkipCache(async () =>
      db.select().from(syncInstancesTable)
    );
    expect(wm.length).toBe(0);
  });

  it("?deleteRecords=1 removes this instance records and reports count, keeps others and local records", async () => {
    await insertInstance("bing-mbp", 42);
    await insertInstance("other-host", 7);
    await insertRecord("remote/bing-mbp/openai", -1);
    await insertRecord("remote/bing-mbp/anthropic", -1);
    await insertRecord("remote/other-host/openai", -1);
    // 本地记录：同 remote 前缀但 vk != -1，绝对不能被级联误删
    await insertRecord("remote/bing-mbp/local-agent", 5);
    await insertRecord("openai", 3);

    const token = await makeToken();
    const res = await DELETE(
      delReq("/api/admin/sync-instances/bing-mbp?deleteRecords=1", token),
      { params: { instance: "bing-mbp" } }
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.deletedRecords).toBe(2);

    expect(await countRecords()).toBe(3);
    expect(await countForProvider("remote/bing-mbp/%")).toBe(1); // 只剩本地记录
    expect(await countForProvider("remote/other-host/%")).toBe(1);
    // 水位行已删，其他实例水位保留
    const wm = await withSkipCache(async () =>
      db.select().from(syncInstancesTable)
    );
    expect(wm.length).toBe(1);
    expect(wm[0].instance).toBe("other-host");
  });

  it("records audit entries with deleteRecords / deletedRecords details", async () => {
    await insertInstance("bing-mbp", 42);
    await insertRecord("remote/bing-mbp/openai", -1);
    const token = await makeToken();

    await DELETE(delReq("/api/admin/sync-instances/bing-mbp?deleteRecords=1", token), {
      params: { instance: "bing-mbp" },
    });
    let details = JSON.parse((await getAuditActions())[0]);
    expect(details.instance).toBe("bing-mbp");
    expect(details.deleteRecords).toBe(true);
    expect(details.deletedRecords).toBe(1);

    await insertInstance("other-host", 1);
    await DELETE(delReq("/api/admin/sync-instances/other-host", token), {
      params: { instance: "other-host" },
    });
    const actions = await getAuditActions();
    const second = JSON.parse(actions[1]);
    expect(second.deleteRecords).toBe(false);
    expect(second.deletedRecords).toBe(0);
  });
});