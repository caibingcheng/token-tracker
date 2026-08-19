import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { db, initDatabase, tokenRecords } from "@/lib/db";
import {
  setAdminApiKey,
  getTokenEpoch,
  deleteSetting,
  setHiddenProvidersSetting,
} from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;

const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-records-route-"));
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
  await deleteSetting("token_epoch").catch(() => {});
  await deleteSetting("hidden_providers").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
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

async function insertRecord(overrides: Partial<typeof tokenRecords.$inferInsert> = {}) {
  await withSkipCache(async () => {
    await db.insert(tokenRecords).values({
      model: overrides.model ?? "gpt-4o",
      provider: overrides.provider ?? "openai",
      agent: overrides.agent ?? "test-agent",
      inputTokens: overrides.inputTokens ?? 100,
      outputTokens: overrides.outputTokens ?? 50,
      cacheRead: overrides.cacheRead ?? 0,
      cacheWrite: overrides.cacheWrite ?? 0,
      status: overrides.status ?? null,
      requestModel: overrides.requestModel ?? null,
      createdAt: overrides.createdAt ?? new Date().toISOString(),
    });
  });
}

describe("records route", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await GET(req("/api/records", "GET"));
    expect(res.status).toBe(401);
  });

  it("returns providerName as the real provider name when no hidden groups configured, without raw provider field", async () => {
    await insertRecord({ model: "gpt-4o", provider: "openai" });
    const token = await makeToken();
    const res = await json(await GET(req("/api/records", "GET", undefined, token)));

    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(1);
    expect(res.data[0].providerName).toBe("openai");
    expect(res.data[0]).not.toHaveProperty("provider");
    expect(res.data[0].normalizedModel).toBe("gpt-4o");
  });

  it("anonymizes providerName for providers matching hidden groups; others keep real name", async () => {
    await insertRecord({ model: "gpt-4o", provider: "openai" });
    await insertRecord({ model: "my-custom-model", provider: "vendor-x" });
    await withSkipCache(async () => {
      await setHiddenProvidersSetting([
        { name: "CustomA", patterns: ["vendor-*"] },
      ]);
    });

    const token = await makeToken();
    const res = await json(await GET(req("/api/records", "GET", undefined, token)));

    const byModel = new Map(res.data.map((r: any) => [r.model, r]));
    expect(byModel.get("gpt-4o").providerName).toBe("openai");
    expect(byModel.get("my-custom-model").providerName).toBe("CustomA");
    // 响应不含任何原始 provider 名（含被隐藏的）
    expect(res.data.some((r: any) => "provider" in r)).toBe(false);
    expect(res.data.some((r: any) => r.provider === "vendor-x")).toBe(false);
  });

  it("returns status field for each record", async () => {
    await insertRecord({ model: "gpt-4o", provider: "openai", status: null });
    await insertRecord({ model: "gpt-4o-mini", provider: "openai", status: "no_usage" });
    await insertRecord({ model: "o1", provider: "openai", status: "client_aborted" });
    await insertRecord({ model: "o3", provider: "openai", status: "stream_interrupted" });

    const token = await makeToken();
    const res = await json(await GET(req("/api/records", "GET", undefined, token)));

    expect(res.success).toBe(true);
    expect(res.data).toHaveLength(4);
    const byModel = new Map(res.data.map((r: any) => [r.model, r]));
    expect(byModel.get("gpt-4o").status).toBeNull();
    expect(byModel.get("gpt-4o-mini").status).toBe("no_usage");
    expect(byModel.get("o1").status).toBe("client_aborted");
    expect(byModel.get("o3").status).toBe("stream_interrupted");
  });
});
