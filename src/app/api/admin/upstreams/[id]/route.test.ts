// Upstream PATCH/DELETE 与探活生命周期联动集成测试（临时 SQLite + 真实 handler + 签名 token）
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { PATCH, DELETE } from "./route";
import {
  db,
  initDatabase,
  upstreamsTable,
  upstreamKeysTable,
  upstreamModelHealthTable,
} from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { setAdminApiKey, getTokenEpoch } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { encryptSecret } from "@/lib/gateway/crypto";
import { healthTracker } from "@/lib/gateway/proxy-deps";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-upstream-id-route-"));
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
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, method: string, token: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": token },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createUpstream(name: string, enabled: boolean): Promise<number> {
  const rows = await withSkipCache(async () => {
    const inserted = await db
      .insert(upstreamsTable)
      .values({
        name,
        protocol: "openai",
        baseUrl: "https://probe.example.com",
        enabledModels: JSON.stringify(["gpt-4o"]),
        enabled: enabled ? 1 : 0,
      })
      .returning();
    await db.insert(upstreamKeysTable).values({
      upstreamId: inserted[0]!.id,
      apiKeyEncrypted: encryptSecret("sk-key-1"),
      enabled: 1,
    });
    return inserted;
  });
  return rows[0]!.id;
}

function stubFetchOk() {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, opts?: { headers?: Headers }) => {
      calls.push(opts?.headers?.get("authorization") ?? "");
      return new Response("{}", {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    })
  );
  return calls;
}

async function waitFor(cond: () => Promise<boolean>, timeoutMs = 3000): Promise<void> {
  const start = Date.now();
  while (!(await cond())) {
    if (Date.now() - start > timeoutMs) throw new Error("waitFor timeout");
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe("/api/admin/upstreams/[id] - 探活生命周期联动", () => {
  it("PATCH enabled=false 停止定时探活（nextAt 清空，状态保留）", async () => {
    const token = await makeToken();
    const id = await createUpstream("up-disable", true);
    await healthTracker.markUnhealthy(id);
    expect(healthTracker.getProbeStatus(id)?.nextAt).not.toBeNull();

    const res = await PATCH(req(`/api/admin/upstreams/${id}`, "PATCH", token, { enabled: false }), {
      params: { id: String(id) },
    });
    expect(res.status).toBe(200);
    expect(healthTracker.getProbeStatus(id)?.nextAt).toBeNull();
    // unhealthy 内存态保留（供 UI 展示与重新启用恢复）
    expect(await healthTracker.isHealthy(id)).toBe(false);
  });

  it("PATCH enabled=true 且 unhealthy → 立即触发一次探活（fire-and-forget）", async () => {
    const token = await makeToken();
    const id = await createUpstream("up-enable", false);
    await healthTracker.markUnhealthy(id);
    healthTracker.stopProbing(id);
    const calls = stubFetchOk();

    const res = await PATCH(req(`/api/admin/upstreams/${id}`, "PATCH", token, { enabled: true }), {
      params: { id: String(id) },
    });
    expect(res.status).toBe(200);
    await waitFor(async () => await healthTracker.isHealthy(id));
    expect(calls.length).toBeGreaterThan(0); // 探活真实发出
    expect(healthTracker.getProbeStatus(id)?.ok).toBe(true);
  });

  it("PATCH enabled=true 且 healthy → 不触发探活", async () => {
    const token = await makeToken();
    const id = await createUpstream("up-enable-healthy", false);
    const calls = stubFetchOk();

    const res = await PATCH(req(`/api/admin/upstreams/${id}`, "PATCH", token, { enabled: true }), {
      params: { id: String(id) },
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 100));
    expect(calls).toHaveLength(0);
  });

  it("DELETE 清理内存态与 upstream_model_health 残留行", async () => {
    const token = await makeToken();
    const id = await createUpstream("up-delete", true);
    await healthTracker.markUnhealthy(id);
    await healthTracker.markModelUnhealthy(id, "gpt-4o");

    const res = await DELETE(req(`/api/admin/upstreams/${id}`, "DELETE", token), {
      params: { id: String(id) },
    });
    expect(res.status).toBe(200);
    expect(healthTracker.getProbeStatus(id)).toBeNull();
    expect(await healthTracker.isHealthy(id)).toBe(true);
    expect(await healthTracker.listModelUnhealthy(id)).toEqual([]);
    const markers = await withSkipCache(async () =>
      db.select().from(upstreamModelHealthTable).where(eq(upstreamModelHealthTable.upstreamId, id))
    );
    expect(markers).toHaveLength(0);
  });
});
