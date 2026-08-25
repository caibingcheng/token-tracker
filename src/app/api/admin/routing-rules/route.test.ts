import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";
import { db, initDatabase, routingRulesTable, upstreamsTable } from "@/lib/db";
import { setAdminApiKey, getTokenEpoch, deleteSetting } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-rr-route-"));
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
    await db.delete(routingRulesTable);
    await db.delete(upstreamsTable);
  });
  await deleteSetting("token_epoch").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, method: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": token ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function insertUpstream(overrides: Partial<Record<string, unknown>> = {}): Promise<any> {
  return withSkipCache(async () => {
    const row = await db
      .insert(upstreamsTable)
      .values({
        name: overrides.name ?? "up-1",
        protocol: overrides.protocol ?? "openai",
        baseUrl: overrides.baseUrl ?? "https://example.com",
        priority: (overrides.priority as number | null) ?? 0,
        enabled: 1,
        enabledModels: '["gpt-4o"]',
      })
      .returning();
    return row[0];
  });
}

describe("routing-rules admin routes - priority & multi-target", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await GET(req("/api/admin/routing-rules", "GET"));
    expect(res.status).toBe(401);
  });

  it("POST: accepts optional priority and defaults to 0", async () => {
    const up = await insertUpstream({ name: "up-a" });
    const token = await makeToken();

    const withPriority = await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "my-alias",
        protocol: "openai",
        upstreamId: up.id,
        targetModel: "gpt-4o-real",
        priority: 3,
      })
    );
    expect(withPriority.status).toBe(201);
    const d1 = await withPriority.json();
    expect(d1.data.priority).toBe(3);

    const upB = await insertUpstream({ name: "up-b" });
    const withoutPriority = await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "my-alias",
        protocol: "openai",
        upstreamId: upB.id,
        targetModel: "gpt-4o-alt",
      })
    );
    expect(withoutPriority.status).toBe(201);
    const d2 = await withoutPriority.json();
    expect(d2.data.priority).toBe(0);
  });

  it("POST: rejects negative or non-integer priority", async () => {
    const up = await insertUpstream({ name: "up-a" });
    const token = await makeToken();
    const res = await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "bad-priority",
        protocol: "openai",
        upstreamId: up.id,
        targetModel: "gpt-4o",
        priority: -1,
      })
    );
    expect(res.status).toBe(400);
    const res2 = await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "bad-priority-2",
        protocol: "openai",
        upstreamId: up.id,
        targetModel: "gpt-4o",
        priority: 1.5,
      })
    );
    expect(res2.status).toBe(400);
  });

  it("POST: same name+protocol with different upstream allowed; same upstream → 409", async () => {
    const upA = await insertUpstream({ name: "up-a" });
    const upB = await insertUpstream({ name: "up-b" });
    const token = await makeToken();

    const first = await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "my-alias",
        protocol: "openai",
        upstreamId: upA.id,
        targetModel: "gpt-4o-a",
      })
    );
    expect(first.status).toBe(201);

    const second = await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "my-alias",
        protocol: "openai",
        upstreamId: upB.id,
        targetModel: "gpt-4o-b",
      })
    );
    expect(second.status).toBe(201);

    const dup = await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "my-alias",
        protocol: "openai",
        upstreamId: upA.id,
        targetModel: "gpt-4o-c",
      })
    );
    expect(dup.status).toBe(409);
    const dupJson = await dup.json();
    expect(dupJson.error).toContain(`upstream ${upA.id}`);
  });

  it("GET: returns rules sorted by name, protocol, priority", async () => {
    const upA = await insertUpstream({ name: "up-a" });
    const upB = await insertUpstream({ name: "up-b" });
    const token = await makeToken();
    await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "my-alias",
        protocol: "openai",
        upstreamId: upA.id,
        targetModel: "gpt-4o-a",
        priority: 5,
      })
    );
    await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "my-alias",
        protocol: "openai",
        upstreamId: upB.id,
        targetModel: "gpt-4o-b",
        priority: 1,
      })
    );
    const res = await GET(req("/api/admin/routing-rules", "GET", token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toHaveLength(2);
    expect(json.data[0].priority).toBe(1); // priority 升序
    expect(json.data[1].priority).toBe(5);
    expect(json.data[0].targetModel).toBe("gpt-4o-b");
  });

  it("PATCH: updates priority and targetModel with audit log", async () => {
    const up = await insertUpstream({ name: "up-a" });
    const token = await makeToken();
    const created = await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "my-alias",
        protocol: "openai",
        upstreamId: up.id,
        targetModel: "gpt-4o-real",
      })
    );
    const rule = (await created.json()).data;

    const res = await PATCH(
      req(`/api/admin/routing-rules/${rule.id}`, "PATCH", token, {
        priority: 4,
        targetModel: "gpt-4o-updated",
      }),
      { params: { id: String(rule.id) } } as any
    );
    expect(res.status).toBe(200);

    const get = await GET(req("/api/admin/routing-rules", "GET", token));
    const json = await get.json();
    const updated = json.data.find((r: any) => r.id === rule.id);
    expect(updated.priority).toBe(4);
    expect(updated.targetModel).toBe("gpt-4o-updated");
  });

  it("PATCH: rejects invalid priority and empty targetModel", async () => {
    const up = await insertUpstream({ name: "up-a" });
    const token = await makeToken();
    const created = await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "my-alias",
        protocol: "openai",
        upstreamId: up.id,
        targetModel: "gpt-4o-real",
      })
    );
    const rule = (await created.json()).data;

    const badPriority = await PATCH(
      req(`/api/admin/routing-rules/${rule.id}`, "PATCH", token, { priority: -2 }),
      { params: { id: String(rule.id) } } as any
    );
    expect(badPriority.status).toBe(400);

    const emptyTarget = await PATCH(
      req(`/api/admin/routing-rules/${rule.id}`, "PATCH", token, { targetModel: "   " }),
      { params: { id: String(rule.id) } } as any
    );
    expect(emptyTarget.status).toBe(400);

    const nothing = await PATCH(
      req(`/api/admin/routing-rules/${rule.id}`, "PATCH", token, {}),
      { params: { id: String(rule.id) } } as any
    );
    expect(nothing.status).toBe(400);
  });

  it("PATCH: returns 404 for missing rule", async () => {
    const token = await makeToken();
    const res = await PATCH(
      req("/api/admin/routing-rules/9999", "PATCH", token, { priority: 1 }),
      { params: { id: "9999" } } as any
    );
    expect(res.status).toBe(404);
  });

  it("DELETE: still works (regression)", async () => {
    const up = await insertUpstream({ name: "up-a" });
    const token = await makeToken();
    const created = await POST(
      req("/api/admin/routing-rules", "POST", token, {
        name: "doomed",
        protocol: "openai",
        upstreamId: up.id,
        targetModel: "gpt-4o",
      })
    );
    const rule = (await created.json()).data;
    const res = await DELETE(
      req(`/api/admin/routing-rules/${rule.id}`, "DELETE", token),
      { params: { id: String(rule.id) } } as any
    );
    expect(res.status).toBe(200);
    const get = await GET(req("/api/admin/routing-rules", "GET", token));
    expect((await get.json()).data).toHaveLength(0);
  });
});
