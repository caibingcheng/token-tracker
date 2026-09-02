import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SyncPusher, BATCH_SIZE } from "./pusher";
import { sql } from "drizzle-orm";
import { db, initDatabase, tokenRecords } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";
import { getSetting, setSetting, deleteSetting } from "@/lib/auth/settings";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const TARGET = "http://a.example.com/ingest/records";
const TOKEN = "it-test-pusher-token-1234567890abcdef";
const UID = "u-0123456789abcdef0123456789abcdef";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-pusher-"));
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
  });
  await setSetting("sync_target_url", TARGET);
  await setSetting("sync_token_encrypted", encryptSecret(TOKEN));
  await setSetting("sync_instance", "b-host");
  await setSetting("sync_instance_uid", UID);
  await setSetting("sync_epoch", "epoch-1");
  await setSetting("sync_cursor", "0");
  await setSetting("sync_dropped_count", "0");
  await deleteSetting("sync_bound_uid").catch(() => {});
  await deleteSetting("sync_last_error").catch(() => {});
  await deleteSetting("sync_last_success_at").catch(() => {});
});

async function insertRecord(overrides: Record<string, unknown> = {}) {
  const clean = Object.fromEntries(
    Object.entries(overrides).filter(([, v]) => v !== undefined)
  );
  await withSkipCache(async () => {
    await db.insert(tokenRecords).values({
      model: "gpt-4o",
      provider: "openai",
      agent: "claude-code",
      inputTokens: 10,
      outputTokens: 5,
      cacheRead: 2,
      cacheWrite: 0,
      virtualKeyId: null,
      createdAt: "2026-09-01T10:00:00.000Z",
      ...clean,
    });
  });
}

async function config(): Promise<{ cursor: number; dropped: number; bound: string | null; lastError: string | null; lastSuccess: string | null }> {
  return {
    cursor: Number(await getSetting("sync_cursor")) || 0,
    dropped: Number(await getSetting("sync_dropped_count")) || 0,
    bound: await getSetting("sync_bound_uid"),
    lastError: await getSetting("sync_last_error"),
    lastSuccess: await getSetting("sync_last_success_at"),
  };
}

function jsonResponse(status: number, data: Record<string, unknown>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("SyncPusher", () => {
  it("pushes one batch and advances cursor past sentinel records", async () => {
    await insertRecord({ id: undefined });
    await insertRecord({ id: undefined });
    await insertRecord({ id: undefined });
    const rows = await withSkipCache(async () => db.select().from(tokenRecords));
    // 制造 -1 哨兵夹在中间：id1 正常、id2 哨兵、id3 正常
    await withSkipCache(async () => {
      await db
        .update(tokenRecords)
        .set({ virtualKeyId: -1 })
        .where(sql`${tokenRecords.id} = ${rows[1]!.id}`);
    });

    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const payload = JSON.parse(String(init?.body)) as { records: Array<{ sourceRecordId: number }> };
      return jsonResponse(200, {
        received: payload.records.length,
        skipped: 0,
        skippedInvalid: [],
        watermark: payload.records[payload.records.length - 1]?.sourceRecordId ?? 0,
        boundUid: UID,
      });
    });

    const pusher = new SyncPusher({ fetchImpl: fetchMock as typeof fetch });
    await pusher.trigger();
    await pusher.trigger(); // 追平后无操作，确认幂等

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]![1]!;
    expect(String(init.redirect)).toBe("manual");
    const payload = JSON.parse(String(init.body)) as {
      instanceUid: string;
      instance: string;
      epoch: string;
      records: Array<{ sourceRecordId: number; model: string }>;
    };
    expect(payload.instanceUid).toBe(UID);
    expect(payload.instance).toBe("b-host");
    expect(payload.epoch).toBe("epoch-1");
    expect(payload.records.map((r) => r.sourceRecordId)).toEqual([rows[0]!.id, rows[2]!.id]);
    expect(payload.records[0]).toMatchObject({ model: "gpt-4o", provider: "openai" });

    const c = await config();
    expect(c.cursor).toBe(rows[2]!.id); // 原始扫描最大 id（含 -1 哨兵）
    expect(c.bound).toBe(UID);
    expect(c.lastSuccess).not.toBeNull();
  });

  it("keeps cursor on 401 with auth error recorded (never drops)", async () => {
    await insertRecord();
    const fetchMock = vi.fn(async () => jsonResponse(401, { error: "Unauthorized" }));
    const pusher = new SyncPusher({ fetchImpl: fetchMock as typeof fetch });
    await pusher.trigger();
    await pusher.trigger();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const c = await config();
    expect(c.cursor).toBe(0);
    expect(c.dropped).toBe(0);
    expect(c.lastError).not.toBeNull();
    const err = JSON.parse(c.lastError!) as { type: string };
    expect(err.type).toBe("auth");
  });

  it("retries on 5xx without dropping", async () => {
    await insertRecord();
    const fetchMock = vi.fn(async () => jsonResponse(503, { error: "busy" }));
    const pusher = new SyncPusher({ fetchImpl: fetchMock as typeof fetch });
    await pusher.trigger();
    const c = await config();
    expect(c.cursor).toBe(0);
    const err = JSON.parse(c.lastError!) as { type: string };
    expect(err.type).toBe("server");
  });

  it("retries on network error without dropping", async () => {
    await insertRecord();
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    const pusher = new SyncPusher({ fetchImpl: fetchMock as typeof fetch });
    await pusher.trigger();
    const c = await config();
    expect(c.cursor).toBe(0);
    const err = JSON.parse(c.lastError!) as { type: string };
    expect(err.type).toBe("network");
  });

  it("drops the batch after 50 rejections (400) and accumulates dropped count", async () => {
    await insertRecord();
    await insertRecord();
    const fetchMock = vi.fn(async () => jsonResponse(400, { error: "Bad batch" }));
    const pusher = new SyncPusher({ fetchImpl: fetchMock as typeof fetch });

    for (let i = 0; i < 49; i++) {
      await pusher.trigger();
    }
    let c = await config();
    expect(c.cursor).toBe(0); // 49 次内不 drop
    expect(c.dropped).toBe(0);

    await pusher.trigger(); // 第 50 次 → drop
    c = await config();
    expect(c.cursor).toBeGreaterThan(0);
    expect(c.dropped).toBe(2);
    expect(c.lastError).not.toBeNull();
    const err = JSON.parse(c.lastError!) as { type: string };
    expect(err.type).toBe("batch_rejected");
  });

  it("accumulates dropped count from skippedInvalid in ack", async () => {
    await insertRecord();
    const fetchMock = vi.fn(async () =>
      jsonResponse(200, { received: 1, skipped: 1, skippedInvalid: [7], watermark: 1, boundUid: null })
    );
    const pusher = new SyncPusher({ fetchImpl: fetchMock as typeof fetch });
    await pusher.trigger();
    const c = await config();
    expect(c.dropped).toBe(1);
  });

  it("does not start when not configured", async () => {
    await deleteSetting("sync_target_url");
    await deleteSetting("sync_token_encrypted");
    await insertRecord();
    const fetchMock = vi.fn();
    const pusher = new SyncPusher({ fetchImpl: fetchMock as typeof fetch });
    await pusher.trigger();
    expect(fetchMock).not.toHaveBeenCalled();
    const c = await config();
    expect(c.cursor).toBe(0);
  });

  it("pushes multiple batches when more than BATCH_SIZE records exist", async () => {
    const rows = [];
    for (let i = 0; i < BATCH_SIZE + 5; i++) {
      rows.push(await insertRecord({ id: undefined }));
    }
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit): Promise<Response> => {
      const payload = JSON.parse(String(init?.body)) as { records: Array<{ sourceRecordId: number }> };
      const last = payload.records[payload.records.length - 1]?.sourceRecordId ?? 0;
      return jsonResponse(200, { received: payload.records.length, skipped: 0, skippedInvalid: [], watermark: last, boundUid: null });
    });
    const pusher = new SyncPusher({ fetchImpl: fetchMock as typeof fetch });
    await pusher.trigger();
    const all = await withSkipCache(async () => db.select().from(tokenRecords));
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((await config()).cursor).toBe(all[all.length - 1]!.id);
  });
});