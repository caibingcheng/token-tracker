import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { initDatabase } from "@/lib/db";
import { setAdminApiKey, getTokenEpoch, deleteSetting, getSetting, setSetting } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-syncskip-"));
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
  await deleteSetting("token_epoch").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
  await setSetting("sync_cursor", "5");
  await setSetting("sync_dropped_count", "0");
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, method: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": token ?? "" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
}

describe("POST /api/admin/sync/skip", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await POST(req("/api/admin/sync/skip", "POST", undefined, { upToRecordId: 10 }));
    expect(res.status).toBe(401);
  });

  it("rejects upToRecordId <= cursor with 400", async () => {
    const token = await makeToken();
    const res = await POST(req("/api/admin/sync/skip", "POST", token, { upToRecordId: 5 }));
    expect(res.status).toBe(400);
    const res2 = await POST(req("/api/admin/sync/skip", "POST", token, { upToRecordId: 3 }));
    expect(res2.status).toBe(400);
    expect(await getSetting("sync_cursor")).toBe("5");
  });

  it("rejects invalid input with 400", async () => {
    const token = await makeToken();
    const res = await POST(req("/api/admin/sync/skip", "POST", token, { upToRecordId: -1 }));
    expect(res.status).toBe(400);
    const res2 = await POST(req("/api/admin/sync/skip", "POST", token, { upToRecordId: "x" }));
    expect(res2.status).toBe(400);
  });

  it("advances cursor and accumulates dropped count", async () => {
    const token = await makeToken();
    const res = await POST(req("/api/admin/sync/skip", "POST", token, { upToRecordId: 12 }));
    expect(res.status).toBe(200);
    expect(await getSetting("sync_cursor")).toBe("12");
    expect(await getSetting("sync_dropped_count")).toBe("7");
  });
});