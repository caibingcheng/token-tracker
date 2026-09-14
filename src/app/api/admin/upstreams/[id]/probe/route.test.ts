// Probe now 端点集成测试：401 / 404 / 200 返回探活状态
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { POST } from "./route";
import { GET as LIST_GET } from "../../route";
import { POST as TEST_MODEL_POST } from "../test-model/route";
import { db, initDatabase, upstreamsTable, upstreamKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { setAdminApiKey, getTokenEpoch } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { encryptSecret } from "@/lib/gateway/crypto";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-probe-route-"));
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
    await db.delete(upstreamsTable);
  });
  vi.unstubAllGlobals();
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-api-key": token ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/admin/upstreams/[id]/probe", () => {
  it("未带 token → 401", async () => {
    const res = await POST(req("/api/admin/upstreams/1/probe"), { params: { id: "1" } });
    expect(res.status).toBe(401);
  });

  it("upstream 不存在 → 404", async () => {
    const token = await makeToken();
    const res = await POST(req("/api/admin/upstreams/999/probe", token), {
      params: { id: "999" },
    });
    expect(res.status).toBe(404);
  });

  it("存在 → 200 返回探活状态（mock fetch 200 → ok）", async () => {
    const token = await makeToken();
    const rows = await withSkipCache(async () => {
      const inserted = await db
        .insert(upstreamsTable)
        .values({
          name: "up-probe",
          protocol: "openai",
          baseUrl: "https://probe.example.com",
          enabledModels: JSON.stringify(["gpt-4o"]),
          enabled: 1,
        })
        .returning();
      await db.insert(upstreamKeysTable).values({
        upstreamId: inserted[0]!.id,
        apiKeyEncrypted: encryptSecret("sk-key-1"),
        enabled: 1,
      });
      return inserted;
    });
    const id = rows[0]!.id;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response("{}", { status: 200, headers: { "content-type": "application/json" } })
      )
    );

    const res = await POST(req(`/api/admin/upstreams/${id}/probe`, token), {
      params: { id: String(id) },
    });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.probe.ok).toBe(true);
    expect(json.probe.lastAt).toBeGreaterThan(0);
  });

  // 回归：test-model（401）标记 unhealthy → 列表显示徽标 → probe（401）→ 徽标必须保持。
  // 用户报告过 probe 后 unhealthy 意外消失（dev 环境模块不一致曾致 truthy 误判），此处锁定行为。
  it("401 全流程：test-model 标记 → probe 后保持 unhealthy", async () => {
    const token = await makeToken();
    const rows = await withSkipCache(async () => {
      const inserted = await db
        .insert(upstreamsTable)
        .values({
          name: "up-repro-401",
          protocol: "openai",
          baseUrl: "https://probe.example.com",
          enabledModels: JSON.stringify(["gpt-4o"]),
          enabled: 1,
        })
        .returning();
      await db.insert(upstreamKeysTable).values({
        upstreamId: inserted[0]!.id,
        apiKeyEncrypted: encryptSecret("sk-wrong-key"),
        enabled: 1,
      });
      return inserted;
    });
    const id = rows[0]!.id;

    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(JSON.stringify({ error: "invalid key" }), {
          status: 401,
          headers: { "content-type": "application/json" },
        })
      )
    );

    const unhealthyFlag = async (): Promise<boolean> => {
      const res = await LIST_GET(
        new NextRequest("http://localhost/api/admin/upstreams", {
          method: "GET",
          headers: { "x-api-key": token },
        })
      );
      const json = await res.json();
      return json.data.find((u: { id: number }) => u.id === id).unhealthy;
    };

    // test-model → 401 → sawAuthError → markUnhealthy → 徽标出现
    const tm = await TEST_MODEL_POST(
      req(`/api/admin/upstreams/${id}/test-model`, token, { model: "gpt-4o" }),
      { params: { id: String(id) } }
    );
    expect(tm.status).toBe(200);
    expect(await unhealthyFlag()).toBe(true);

    // probe now → 401 → 必须保持 unhealthy（用户报告此处意外消失）
    const p1 = await POST(req(`/api/admin/upstreams/${id}/probe`, token), {
      params: { id: String(id) },
    });
    const p1json = await p1.json();
    expect(p1json.probe.ok).toBe(false);
    expect(p1json.probe.status).toBe(401);
    expect(await unhealthyFlag()).toBe(true);

    // 再来一轮：test-model 重新标记 → probe 仍保持
    await TEST_MODEL_POST(
      req(`/api/admin/upstreams/${id}/test-model`, token, { model: "gpt-4o" }),
      { params: { id: String(id) } }
    );
    expect(await unhealthyFlag()).toBe(true);
    const p2 = await POST(req(`/api/admin/upstreams/${id}/probe`, token), {
      params: { id: String(id) },
    });
    expect((await p2.json()).probe.ok).toBe(false);
    expect(await unhealthyFlag()).toBe(true);
  }, 20000);
});
