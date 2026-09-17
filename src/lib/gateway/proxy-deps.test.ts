// probeUpstream 集成测试：临时 SQLite + mock global fetch。
// 覆盖：全 key 链任一成功即恢复、404 放宽分支（model 标记清除）、401 不放宽、5xx 不放宽。
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { eq } from "drizzle-orm";
import {
  db,
  initDatabase,
  upstreamsTable,
  upstreamKeysTable,
  upstreamModelHealthTable,
} from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-proxy-deps-"));
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
    await db.delete(upstreamKeysTable);
    await db.delete(upstreamModelHealthTable);
    await db.delete(upstreamsTable);
  });
  vi.unstubAllGlobals();
});

const BASE_URL = "https://probe.example.com";

// 创建 upstream + 两个启用 key（sk-key-1 / sk-key-2），返回 upstream id
async function createUpstream(name: string, models: string[]): Promise<number> {
  const inserted = await withSkipCache(async () => {
    const rows = await db
      .insert(upstreamsTable)
      .values({
        name,
        protocol: "openai",
        baseUrl: BASE_URL,
        enabledModels: JSON.stringify(models),
        enabled: 1,
      })
      .returning();
    for (const key of ["sk-key-1", "sk-key-2"]) {
      await db.insert(upstreamKeysTable).values({
        upstreamId: rows[0]!.id,
        apiKeyEncrypted: encryptSecret(key),
        enabled: 1,
      });
    }
    return rows;
  });
  return inserted[0]!.id;
}

// mock fetch：按 Authorization 头区分 key，返回每个 key 预设的 status
function stubFetchByKey(statusForKey: Record<string, number>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, opts?: { headers?: Headers }) => {
      const auth = opts?.headers?.get("authorization") ?? "";
      const key = auth.replace(/^Bearer\s+/i, "");
      calls.push(key);
      const status = statusForKey[key] ?? 500;
      return new Response(JSON.stringify({ error: `status ${status}` }), {
        status,
        headers: { "content-type": "application/json" },
      });
    })
  );
  return calls;
}

describe("probeUpstream（经 healthTracker.probeNow 驱动）", () => {
  it("全 key 链：key[0] 失效但 key[1] 成功 → 恢复", async () => {
    const { healthTracker } = await import("./proxy-deps");
    const id = await createUpstream("up-keys", ["gpt-4o"]);
    const calls = stubFetchByKey({ "sk-key-1": 401, "sk-key-2": 200 });

    await healthTracker.markUnhealthy(id);
    expect(await healthTracker.isHealthy(id)).toBe(false);

    const status = await healthTracker.probeNow(id);
    expect(calls).toEqual(["sk-key-1", "sk-key-2"]); // 链式逐个尝试
    expect(status?.ok).toBe(true);
    expect(await healthTracker.isHealthy(id)).toBe(true);
    const rows = await withSkipCache(async () =>
      db.select().from(upstreamsTable).where(eq(upstreamsTable.id, id))
    );
    expect(rows[0]!.healthStatus).toBeNull(); // DB 状态已清除
  });

  it("404 放宽：全部 key 404（model 不存在）→ 视为恢复，并清被探测 model 的标记", async () => {
    const { healthTracker } = await import("./proxy-deps");
    const id = await createUpstream("up-404", ["gpt-4o"]);
    stubFetchByKey({ "sk-key-1": 404, "sk-key-2": 404 });

    await healthTracker.markUnhealthy(id);
    await healthTracker.markModelUnhealthy(id, "gpt-4o");
    expect(await healthTracker.isModelHealthy(id, "gpt-4o")).toBe(false);

    const status = await healthTracker.probeNow(id);
    expect(status?.ok).toBe(true); // 放宽恢复
    expect(await healthTracker.isHealthy(id)).toBe(true);
    expect(await healthTracker.isModelHealthy(id, "gpt-4o")).toBe(true); // 探测 model 标记已清
    const markers = await withSkipCache(async () =>
      db.select().from(upstreamModelHealthTable).where(eq(upstreamModelHealthTable.upstreamId, id))
    );
    expect(markers).toHaveLength(0); // DB 残留行同步清除
  });

  it("401 不放宽：全部 key 401 → 保持 unhealthy", async () => {
    const { healthTracker } = await import("./proxy-deps");
    const id = await createUpstream("up-401", ["gpt-4o"]);
    stubFetchByKey({ "sk-key-1": 401, "sk-key-2": 401 });

    await healthTracker.markUnhealthy(id);
    const status = await healthTracker.probeNow(id);
    expect(status?.ok).toBe(false);
    expect(status?.status).toBe(401);
    expect(await healthTracker.isHealthy(id)).toBe(false);
  });

  it("5xx 不放宽：全部 key 503 → 保持 unhealthy", async () => {
    const { healthTracker } = await import("./proxy-deps");
    const id = await createUpstream("up-5xx", ["gpt-4o"]);
    stubFetchByKey({ "sk-key-1": 503, "sk-key-2": 503 });

    await healthTracker.markUnhealthy(id);
    const status = await healthTracker.probeNow(id);
    expect(status?.ok).toBe(false);
    expect(status?.status).toBe(503);
    expect(await healthTracker.isHealthy(id)).toBe(false);
  });

  it("无 key 的 upstream 探活失败保持 unhealthy", async () => {
    const { healthTracker } = await import("./proxy-deps");
    const rows = await withSkipCache(async () =>
      db
        .insert(upstreamsTable)
        .values({
          name: "up-no-keys",
          protocol: "openai",
          baseUrl: BASE_URL,
          enabledModels: JSON.stringify(["gpt-4o"]),
          enabled: 1,
        })
        .returning()
    );
    await healthTracker.markUnhealthy(rows[0]!.id);
    const status = await healthTracker.probeNow(rows[0]!.id);
    expect(status?.ok).toBe(false);
    expect(await healthTracker.isHealthy(rows[0]!.id)).toBe(false);
  });
});
