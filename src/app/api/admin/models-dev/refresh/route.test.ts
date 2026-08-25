import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { db, initDatabase, adminAuditLogsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import {
  setAdminApiKey,
  getTokenEpoch,
  deleteSetting,
} from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { resetSnapshotCache } from "@/lib/models-dev/snapshot";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;

const ADMIN_KEY = "test-admin-key-123456";

let dir: string;
let snapshotPath: string;

const SNAPSHOT = {
  fetchedAt: "2026-08-21T13:30:49.211Z",
  data: {
    openai: {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-4o": {
          id: "gpt-4o",
          cost: { input: 2.5, output: 10 },
          last_updated: "2026-07-01",
        },
      },
    },
  },
};

const API_JSON = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o": { id: "gpt-4o", cost: { input: 2.5, output: 10 } },
    },
  },
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-mdrefresh-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
  snapshotPath = join(dir, "models-dev-cache.json");
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
  writeFileSync(snapshotPath, JSON.stringify(SNAPSHOT), "utf-8");
  resetSnapshotCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, method: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      "x-api-key": token ?? "",
    },
  });
}

async function json(res: Response) {
  return (await res.json()) as Record<string, any>;
}

describe("POST /api/admin/models-dev/refresh", () => {
  it("rejects without session token (401)", async () => {
    const res = await POST(req("/api/admin/models-dev/refresh", "POST"));
    expect(res.status).toBe(401);
  });

  it("reports network failure with categorized message (502)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network down")));
    const token = await makeToken();
    const res = await POST(req("/api/admin/models-dev/refresh", "POST", token));
    expect(res.status).toBe(502);
    expect((await json(res)).error).toMatch(/network error/i);
  });

  it("reports upstream HTTP failure with status (502)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, status: 500, json: async () => ({}) })
    );
    const token = await makeToken();
    const res = await POST(req("/api/admin/models-dev/refresh", "POST", token));
    expect(res.status).toBe(502);
    expect((await json(res)).error).toMatch(/HTTP 500/i);
  });

  it("reports invalid response shape (502)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => ({ p1: { id: "p1" } }),
      })
    );
    const token = await makeToken();
    const res = await POST(req("/api/admin/models-dev/refresh", "POST", token));
    expect(res.status).toBe(502);
    expect((await json(res)).error).toMatch(/invalid response shape/i);
  });

  it("refreshes snapshot on success and writes audit log (200)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => API_JSON })
    );
    const token = await makeToken();
    const res = await POST(req("/api/admin/models-dev/refresh", "POST", token));
    expect(res.status).toBe(200);
    const j = await json(res);
    expect(j.success).toBe(true);
    expect(j.data.fetchedAt).toBeTruthy();

    const logs = await withSkipCache(async () =>
      db.select().from(adminAuditLogsTable)
    );
    const refreshLog = logs.find((l) => l.action === "models_dev_refresh");
    expect(refreshLog).toBeTruthy();
    expect(JSON.parse(refreshLog!.details!)).toEqual({
      fetchedAt: j.data.fetchedAt,
    });
  });
});
