import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { DELETE } from "./route";
import { db, initDatabase, adminAuditLogsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import {
  setAdminApiKey,
  getTokenEpoch,
  deleteSetting,
  getSetting,
  setSetting,
} from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { encryptSecret } from "@/lib/gateway/crypto";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-syncconfig-"));
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
    await db.delete(adminAuditLogsTable);
  });
  await deleteSetting("token_epoch").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
  // 预置一份完整推送配置
  await setSetting("sync_target_url", "http://a.example.com/ingest/records");
  await setSetting("sync_token_encrypted", encryptSecret("it-test-token-1234567890abcdef"));
  await setSetting("sync_instance", "b-host");
  await setSetting("sync_instance_uid", "u-0123456789abcdef0123456789abcdef");
  await setSetting("sync_epoch", "epoch-1");
  await setSetting("sync_cursor", "42");
  await setSetting("sync_dropped_count", "7");
  await setSetting("sync_bound_uid", "u-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
  await setSetting("sync_last_success_at", "2026-09-01T10:00:00.000Z");
  await setSetting(
    "sync_last_error",
    JSON.stringify({ type: "network", message: "fetch failed", firstFailedAt: "2026-09-01T09:00:00.000Z" })
  );
  await setSetting("sync_last_attempt_at", "2026-09-01T09:00:00.000Z");
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(token?: string): NextRequest {
  return new NextRequest("http://localhost/api/admin/sync/config", {
    method: "DELETE",
    headers: { "x-api-key": token ?? "" },
  });
}

describe("DELETE /api/admin/sync/config", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await DELETE(req());
    expect(res.status).toBe(401);
    // 未动配置
    expect(await getSetting("sync_target_url")).not.toBeNull();
  });

  it("clears credentials and push state, keeps cursor/epoch/uid/instance/last_success", async () => {
    const token = await makeToken();
    const res = await DELETE(req(token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.targetUrl).toBeNull();
    expect(json.data.hasToken).toBe(false);
    // uid/instance/epoch 保留且回显
    expect(json.data.uid).toBe("u-0123456789abcdef0123456789abcdef");
    expect(json.data.instance).toBe("b-host");
    expect(json.data.epoch).toBe("epoch-1");
    expect(json.data.boundUid).toBeNull();

    // 清除项
    expect(await getSetting("sync_target_url")).toBeNull();
    expect(await getSetting("sync_token_encrypted")).toBeNull();
    expect(await getSetting("sync_bound_uid")).toBeNull();
    expect(await getSetting("sync_last_error")).toBeNull();
    expect(await getSetting("sync_last_attempt_at")).toBeNull();
    // 保留项
    expect(await getSetting("sync_cursor")).toBe("42");
    expect(await getSetting("sync_dropped_count")).toBe("7");
    expect(await getSetting("sync_epoch")).toBe("epoch-1");
    expect(await getSetting("sync_instance_uid")).toBe("u-0123456789abcdef0123456789abcdef");
    expect(await getSetting("sync_instance")).toBe("b-host");
    expect(await getSetting("sync_last_success_at")).toBe("2026-09-01T10:00:00.000Z");
  });

  it("is idempotent no-op when not configured", async () => {
    const token = await makeToken();
    const first = await DELETE(req(token));
    expect(first.status).toBe(200);
    const second = await DELETE(req(token));
    expect(second.status).toBe(200);
    const json = await second.json();
    expect(json.success).toBe(true);
    expect(json.data.hasToken).toBe(false);
  });

  it("writes audit log with cursor snapshot", async () => {
    const token = await makeToken();
    await DELETE(req(token));
    const rows = await withSkipCache(async () =>
      db.select().from(adminAuditLogsTable)
    );
    const audit = rows.find((r) => r.action === "sync_config_deleted");
    expect(audit).toBeDefined();
    const details = JSON.parse(audit!.details ?? "{}") as {
      hadConfig: boolean;
      cursor: number;
      droppedCount: number;
    };
    expect(details.hadConfig).toBe(true);
    expect(details.cursor).toBe(42);
    expect(details.droppedCount).toBe(7);
  });
});
