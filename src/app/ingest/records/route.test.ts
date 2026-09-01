import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { db, initDatabase, tokenRecords, ingestTokensTable, syncInstancesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";
import { eq } from "drizzle-orm";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const TOKEN_PLAIN = "it-testtoken12345678901234567890abcd";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-ingest-route-"));
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
    await db.delete(ingestTokensTable);
    await db.delete(syncInstancesTable);
  });
  await withSkipCache(async () => {
    await db.insert(ingestTokensTable).values({
      name: "test-token",
      apiKeyEncrypted: encryptSecret(TOKEN_PLAIN),
      enabled: 1,
    });
  });
});

function body(overrides: Record<string, unknown> = {}) {
  return {
    instance: "bing-mbp",
    epoch: "epoch-abc",
    records: [
      {
        sourceRecordId: 1,
        model: "gpt-4o",
        provider: "openai",
        agent: "claude-code",
        inputTokens: 10,
        outputTokens: 5,
        cacheRead: 2,
        cacheWrite: 0,
        status: null,
        latencyMs: 120,
        ttftMs: 80,
        requestModel: "gpt-4o",
        userAgent: "test-agent",
        createdAt: "2026-09-01T10:00:00.000Z",
      },
    ],
    ...overrides,
  };
}

function post(payload: unknown, token = TOKEN_PLAIN): NextRequest {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return new NextRequest("http://localhost/ingest/records", {
    method: "POST",
    headers,
    body: typeof payload === "string" ? payload : JSON.stringify(payload),
  });
}

async function countRecords(): Promise<number> {
  return withSkipCache(async () => {
    const rows = await db.select().from(tokenRecords);
    return rows.length;
  });
}

async function getWatermark(instance: string): Promise<any | null> {
  return withSkipCache(async () => {
    const rows = await db
      .select()
      .from(syncInstancesTable)
      .where(eq(syncInstancesTable.instance, instance));
    return rows[0] ?? null;
  });
}

describe("POST /ingest/records", () => {
  it("rejects missing/invalid token with 401", async () => {
    const res = await POST(post(body(), ""));
    expect(res.status).toBe(401);
    const res2 = await POST(post(body(), "it-wrongtoken"));
    expect(res2.status).toBe(401);
    expect(await countRecords()).toBe(0);
  });

  it("rejects disabled token with 401", async () => {
    await withSkipCache(async () => {
      await db
        .update(ingestTokensTable)
        .set({ enabled: 0 })
        .where(eq(ingestTokensTable.name, "test-token"));
    });
    const res = await POST(post(body()));
    expect(res.status).toBe(401);
  });

  it("rejects malformed body with 400", async () => {
    const res = await POST(post("not-json"));
    expect(res.status).toBe(400);
    const res2 = await POST(post({ instance: "BAD", epoch: "e", records: [] }));
    expect(res2.status).toBe(400);
  });

  it("rejects body over 2MB with 413", async () => {
    const big = "x".repeat(2 * 1024 * 1024 + 10);
    const res = await POST(post(big));
    expect(res.status).toBe(413);
  });

  it("rejects batches over 500 records with 400", async () => {
    const records = Array.from({ length: 501 }, (_, i) => ({
      sourceRecordId: i + 1,
      model: "gpt-4o",
      provider: "openai",
      agent: "a",
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      status: null,
      latencyMs: null,
      ttftMs: null,
      requestModel: null,
      userAgent: null,
      createdAt: "2026-09-01T10:00:00.000Z",
    }));
    const res = await POST(post({ instance: "ok", epoch: "e", records }));
    expect(res.status).toBe(400);
  });

  it("writes records with prefixed provider/agent and sentinel virtual_key_id=-1, preserves createdAt", async () => {
    const res = await POST(post(body()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.received).toBe(1);
    expect(json.watermark).toBe(1);
    expect(json.boundInstance).toBe("bing-mbp");

    const row = (
      await withSkipCache(async () => db.select().from(tokenRecords))
    )[0] as any;
    expect(row.provider).toBe("remote/bing-mbp/openai");
    expect(row.agent).toBe("remote/bing-mbp/claude-code");
    expect(row.virtualKeyId).toBe(-1);
    expect(row.createdAt).toBe("2026-09-01T10:00:00.000Z");
    expect(row.inputTokens).toBe(10);
    expect(row.latencyMs).toBe(120);
    expect(row.ttftMs).toBe(80);
    expect(row.requestModel).toBe("gpt-4o");
    expect(row.userAgent).toBe("test-agent");
  });

  it("TOFU: first push binds, same instance ok, different instance 403 instance_mismatch", async () => {
    const first = await POST(post(body()));
    expect(first.status).toBe(200);

    const same = await POST(post(body({ records: [{ ...body().records[0], sourceRecordId: 2 }] })));
    expect(same.status).toBe(200);
    expect((await same.json()).boundInstance).toBe("bing-mbp");

    const other = await POST(post(body({ instance: "other-host" })));
    expect(other.status).toBe(403);
    const json = await other.json();
    expect(json.error).toBe("instance_mismatch");
    expect(json.boundInstance).toBe("bing-mbp");

    const tokenRow = await withSkipCache(async () =>
      db.select().from(ingestTokensTable)
    );
    expect(tokenRow[0].boundInstance).toBe("bing-mbp");
  });

  it("dedup: same epoch + re-push of covered sourceRecordIds is skipped", async () => {
    const first = await POST(
      post(body({ records: [body().records[0], { ...body().records[0], sourceRecordId: 2 }] }))
    );
    expect((await first.json()).received).toBe(2);

    const replay = await POST(post(body({ records: [body().records[0], { ...body().records[0], sourceRecordId: 3 }] })));
    const json = await replay.json();
    expect(json.received).toBe(1); // id 1 去重，id 3 写入
    expect(json.watermark).toBe(3);
    expect(await countRecords()).toBe(3);
  });

  it("epoch change resets watermark to 0 (B DB rebuilt)", async () => {
    await POST(post(body()));
    const rebuilt = await POST(post(body({ epoch: "epoch-new" })));
    const json = await rebuilt.json();
    expect(json.watermark).toBe(1);
    const wm = await getWatermark("bing-mbp");
    expect(wm.epoch).toBe("epoch-new");
    expect(wm.lastRecordId).toBe(1);
  });

  it("partial accept: invalid records are skipped with skippedInvalid ids", async () => {
    const res = await POST(
      post(
        body({
          records: [
            body().records[0],
            { ...body().records[0], sourceRecordId: 2, inputTokens: -1 },
            { ...body().records[0], sourceRecordId: 3, createdAt: "bad" },
          ],
        })
      )
    );
    const json = await res.json();
    expect(json.received).toBe(1);
    expect(json.skipped).toBe(2);
    expect(json.skippedInvalid).toEqual([2, 3]);
    expect(await countRecords()).toBe(1);
  });

  it("concurrent same-instance pushes: records written only once (serialized)", async () => {
    const payload = body();
    const [a, b] = await Promise.all([POST(post(payload)), POST(post(payload))]);
    const [ja, jb] = [await a.json(), await b.json()];
    // 两个请求都成功返回（SQLite 串行化），但合计写入不重复：一个 received=1，另一个 received=0
    expect([ja.received, jb.received].sort()).toEqual([0, 1]);
    expect(await countRecords()).toBe(1);
    const wm = await getWatermark("bing-mbp");
    expect(wm.lastRecordId).toBe(1);
  });

  it("watermark only advances (never rewinds) within same epoch", async () => {
    await POST(post(body()));
    await POST(post(body({ epoch: "epoch-new", records: [] })));
    await POST(post(body({ epoch: "epoch-new", records: [{ ...body().records[0], sourceRecordId: 5 }] })));
    const wm = await getWatermark("bing-mbp");
    expect(wm.lastRecordId).toBe(5);
  });
});