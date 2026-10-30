import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SyncPusher } from "./pusher";
import { db, initDatabase, tokenRecords } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";
import { getSetting, setSetting, deleteSetting } from "@/lib/auth/settings";
import { getSyncDispatcher } from "@/lib/gateway/proxy-dispatcher";

// 真实出站回归：sync 配置层允许 loopback 明文 http，运行时就必须真的连得上
// （此前 guarded dispatcher 拒绝 loopback，导致「配置允许、实际不可用」）；
// 同时验证私网目标（非 loopback）在推送侧被拦下，不会把 ingest token 发出去。

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const TOKEN = "it-loopback-test-token-1234567890";
const UID = "u-0123456789abcdef0123456789abcdef";

let dir: string;
let server: Server;
let port: number;
let received: Array<{ url: string; auth: string | undefined; body: string }>;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tt-pusher-loopback-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";

  received = [];
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      received.push({ url: req.url ?? "", auth: req.headers.authorization, body });
      const parsed = JSON.parse(body || "{}") as {
        records?: Array<{ sourceRecordId: number }>;
      };
      const ids = (parsed.records ?? []).map((r) => r.sourceRecordId);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          received: ids.length,
          skipped: 0,
          skippedInvalid: [],
          watermark: ids[ids.length - 1] ?? 0,
          boundUid: UID,
        })
      );
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as { port: number }).port;
});

afterAll(async () => {
  // 关掉 sync 专用 dispatcher 的 keep-alive 连接池，避免 worker 退出时残留 socket
  await (getSyncDispatcher() as { close?: () => Promise<void> }).close?.().catch(() => {});
  server?.closeAllConnections?.();
  await new Promise<void>((resolve) => server?.close(() => resolve()));
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
  received.length = 0;
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

async function insertRecord(): Promise<number> {
  return withSkipCache(async () => {
    const rows = await db
      .insert(tokenRecords)
      .values({
        model: "gpt-4o",
        provider: "openai",
        agent: "claude-code",
        inputTokens: 10,
        outputTokens: 5,
        cacheRead: 0,
        cacheWrite: 0,
        virtualKeyId: null,
        createdAt: "2026-09-01T10:00:00.000Z",
      })
      .returning({ id: tokenRecords.id });
    return rows[0]!.id;
  });
}

describe("SyncPusher 真实出站（loopback 例外 / 私网阻断）", () => {
  it("http://localhost 目标真实推送成功（打磨后的 loopback 例外生效）", async () => {
    // 默认 dispatcher（无 fetchImpl 覆盖）：走真实 undici fetch + sync loopback 例外
    await setSetting("sync_target_url", `http://localhost:${port}/ingest/records`);
    const id = await insertRecord();

    const pusher = new SyncPusher();
    await pusher.trigger();

    expect(received).toHaveLength(1);
    expect(received[0]!.url).toBe("/ingest/records");
    expect(received[0]!.auth).toBe(`Bearer ${TOKEN}`);
    const payload = JSON.parse(received[0]!.body) as {
      instanceUid: string;
      records: Array<{ sourceRecordId: number }>;
    };
    expect(payload.instanceUid).toBe(UID);
    expect(payload.records.map((r) => r.sourceRecordId)).toContain(id);

    expect(Number(await getSetting("sync_cursor"))).toBe(id);
    expect(await getSetting("sync_last_error")).toBeNull();
    expect(await getSetting("sync_bound_uid")).toBe(UID);
  });

  it("http://127.0.0.1 明文目标同样可推送（字面环回 IP）", async () => {
    await setSetting("sync_target_url", `http://127.0.0.1:${port}/ingest/records`);
    const id = await insertRecord();
    const pusher = new SyncPusher();
    await pusher.trigger();
    expect(received).toHaveLength(1);
    expect(Number(await getSetting("sync_cursor"))).toBe(id);
    expect(await getSetting("sync_last_error")).toBeNull();
  });

  it("非 loopback 私网目标被拦下：不发请求、token 不出网、游标不动", async () => {
    await setSetting("sync_target_url", "https://10.0.0.5/ingest/records");
    const id = await insertRecord();

    const pusher = new SyncPusher();
    await pusher.trigger();

    expect(received).toHaveLength(0);
    expect(Number(await getSetting("sync_cursor"))).toBe(0);
    expect(Number(await getSetting("sync_cursor"))).toBeLessThan(id);
    const err = JSON.parse((await getSetting("sync_last_error"))!) as {
      type: string;
      message: string;
    };
    expect(err.type).toBe("config");
    expect(err.message).toMatch(/private|https/);
  });

  it("非 loopback 私网明文 http 目标同样被拦下", async () => {
    await setSetting("sync_target_url", "http://192.168.1.10:3000/ingest/records");
    await insertRecord();
    const pusher = new SyncPusher();
    await pusher.trigger();
    expect(received).toHaveLength(0);
    const err = JSON.parse((await getSetting("sync_last_error"))!) as { type: string };
    expect(err.type).toBe("config");
  });
});
