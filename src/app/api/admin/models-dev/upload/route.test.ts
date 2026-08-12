import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "fs";
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
import { getSnapshot, resetSnapshotCache } from "@/lib/models-dev/snapshot";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;

const ADMIN_KEY = "test-admin-key-123456";

let dir: string;
let snapshotPath: string;

const SNAPSHOT = {
  fetchedAt: "2026-08-01T00:00:00.000Z",
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

// 模拟 models.dev api.json 原文（合法）
const API_JSON = {
  openai: {
    id: "openai",
    name: "OpenAI",
    models: {
      "gpt-4o": { id: "gpt-4o", cost: { input: 2.5, output: 10 } },
      "gpt-4o-mini": { id: "gpt-4o-mini", cost: { input: 0.15, output: 0.6 } },
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    models: {
      "claude-sonnet-4-6": {
        id: "claude-sonnet-4-6",
        cost: { input: 3, output: 15, cache_read: 0.3 },
      },
    },
  },
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-mdupload-"));
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
  // 恢复初始磁盘快照（上传用例会覆盖文件，防止用例间污染）
  writeFileSync(snapshotPath, JSON.stringify(SNAPSHOT), "utf-8");
  resetSnapshotCache();
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, method: string, body?: unknown, token?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-key": token ?? "",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(res: Response) {
  return (await res.json()) as Record<string, any>;
}

describe("POST /api/admin/models-dev/upload", () => {
  it("rejects without session token (401)", async () => {
    const res = await POST(req("/api/admin/models-dev/upload", "POST", API_JSON));
    expect(res.status).toBe(401);
  });

  it("rejects invalid JSON body (400)", async () => {
    const token = await makeToken();
    const r = new NextRequest("http://localhost/api/admin/models-dev/upload", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": token },
      body: "{not json",
    });
    const res = await POST(r);
    expect(res.status).toBe(400);
  });

  it("rejects non-snapshot JSON (400)", async () => {
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/models-dev/upload", "POST", { foo: "bar" }, token)
    );
    expect(res.status).toBe(400);
    const j = await json(res);
    expect(j.error).toMatch(/api\.json|snapshot/i);
  });

  it("accepts api.json payload: updates memory cache + disk + audit log", async () => {
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/models-dev/upload", "POST", API_JSON, token)
    );
    expect(res.status).toBe(200);
    const j = await json(res);
    expect(j.success).toBe(true);
    expect(j.dropped).toBe(0);
    expect(j.data.fetchedAt).toBeTruthy();

    // 内存缓存立即生效（无需重启）
    const snap = await getSnapshot();
    expect(snap?.data.anthropic.models["claude-sonnet-4-6"].cost.input).toBe(3);
    expect(snap?.data.anthropic.models["claude-sonnet-4-6"].cost.cache_read).toBe(0.3);
    expect(snap?.data.openai.models["gpt-4o-mini"].cost.output).toBe(0.6);

    // 磁盘已更新
    const onDisk = JSON.parse(readFileSync(snapshotPath, "utf-8"));
    expect(onDisk.data.anthropic.models["claude-sonnet-4-6"].cost.input).toBe(3);

    // 审计落库
    const logs = await withSkipCache(async () =>
      db.select().from(adminAuditLogsTable)
    );
    const upload = logs.find((l) => l.action === "models_dev_upload");
    expect(upload).toBeTruthy();
    const details = JSON.parse(upload!.details!);
    expect(details.providerCount).toBe(2);
    expect(details.dropped).toBe(0);
  });

  it("accepts {fetchedAt, data} wrapper format (reuse downloaded cache file)", async () => {
    const token = await makeToken();
    const wrapped = { fetchedAt: "2026-08-10T00:00:00.000Z", data: API_JSON };
    const res = await POST(
      req("/api/admin/models-dev/upload", "POST", wrapped, token)
    );
    expect(res.status).toBe(200);
    const snap = await getSnapshot();
    expect(snap?.data.openai.models["gpt-4o-mini"]).toBeTruthy();
  });

  it("rejects snapshot where all models are invalid (400)", async () => {
    const token = await makeToken();
    const allBad = {
      p1: {
        id: "p1",
        models: {
          neg: { id: "neg", cost: { input: -1, output: 2 } },
          str: { id: "str", cost: { input: "2.5", output: 2 } },
        },
      },
    };
    const res = await POST(
      req("/api/admin/models-dev/upload", "POST", allBad, token)
    );
    expect(res.status).toBe(400);
  });

  it("drops invalid entries and reports count (200 with dropped)", async () => {
    const token = await makeToken();
    const mixed = {
      openai: {
        id: "openai",
        models: {
          good: { id: "good", cost: { input: 1, output: 2 } },
          neg: { id: "neg", cost: { input: -5, output: 2 } },
          str: { id: "str", cost: { input: "oops", output: 2 } },
          badCache: {
            id: "badCache",
            cost: { input: 1, output: 2, cache_read: -0.1 },
          },
          noPrice: { id: "noPrice" },
        },
      },
    };
    const res = await POST(
      req("/api/admin/models-dev/upload", "POST", mixed, token)
    );
    expect(res.status).toBe(200);
    const j = await json(res);
    expect(j.success).toBe(true);
    expect(j.dropped).toBe(3);

    const snap = await getSnapshot();
    expect(snap?.data.openai.models.good).toBeTruthy();
    expect(snap?.data.openai.models.neg).toBeUndefined();
    expect(snap?.data.openai.models.str).toBeUndefined();
    expect(snap?.data.openai.models.badCache).toBeUndefined();
    // 无价格条目（官方合法）保留
    expect(snap?.data.openai.models.noPrice).toBeTruthy();
  });

  it("rejects oversized upload via content-length (413)", async () => {
    const token = await makeToken();
    const r = new NextRequest("http://localhost/api/admin/models-dev/upload", {
      method: "POST",
      headers: { "x-api-key": token, "content-length": "10485761" },
    });
    const res = await POST(r);
    expect(res.status).toBe(413);
  });
});
