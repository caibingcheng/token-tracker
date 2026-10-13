import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";
import { POST as ADD_TARGET } from "./[id]/targets/route";
import { PATCH as PATCH_TARGET, DELETE as DELETE_TARGET } from "./[id]/targets/[targetId]/route";
import { db, initDatabase, namedRouteTargetsTable, namedRoutesTable, upstreamsTable } from "@/lib/db";
import { setAdminApiKey, getTokenEpoch, deleteSetting } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-named-routes-route-"));
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
    await db.delete(namedRouteTargetsTable);
    await db.delete(namedRoutesTable);
    await db.delete(upstreamsTable);
    await db.insert(upstreamsTable).values([
      { name: "up-openai", protocol: "openai", baseUrl: "https://a.example" },
      {
        name: "up-classifier",
        protocol: "openai",
        baseUrl: "https://c.example",
        classifierModels: JSON.stringify([{ model: "jev-latest", type: "jev-systemone" }]),
      },
      { name: "up-anthropic", protocol: "anthropic", baseUrl: "https://b.example" },
    ]);
  });
  await deleteSetting("token_epoch").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

afterEach(() => {
  deleteSetting("token_epoch").catch(() => {});
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

async function ctx(id: number) {
  return { params: { id: String(id) } };
}

async function upstreamIdByName(name: string): Promise<number> {
  const rows = await db.select().from(upstreamsTable);
  return (rows.find((r: any) => r.name === name) as any).id;
}

describe("/api/admin/named-routes", () => {
  it("creates a named route with a first target and lists it", async () => {
    const token = await makeToken();
    const upstreamId = await upstreamIdByName("up-openai");
    const res = await POST(
      req("/api/admin/named-routes", "POST", token, {
        name: "cheap",
        protocol: "openai",
        target: { upstreamId, targetModel: "gpt-4o-mini", description: "cheap tier", priority: 1 },
      })
    );
    expect(res.status).toBe(201);

    const list = await GET(req("/api/admin/named-routes", "GET", token));
    const json = await list.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toMatchObject({
      name: "cheap",
      protocol: "openai",
      classifierKind: "priority",
      classifierUpstreamId: 0,
      classifierModel: "",
      enabled: true,
    });
    expect(json.data[0].targets).toEqual([
      expect.objectContaining({
        upstreamId,
        upstreamName: "up-openai",
        targetModel: "gpt-4o-mini",
        description: "cheap tier",
        priority: 1,
      }),
    ]);
  });

  it("rejects duplicate name + protocol with 409", async () => {
    const token = await makeToken();
    const body = { name: "cheap", protocol: "openai" };
    expect((await POST(req("/api/admin/named-routes", "POST", token, body))).status).toBe(201);
    expect((await POST(req("/api/admin/named-routes", "POST", token, body))).status).toBe(409);
  });

  it("rejects a target whose upstream protocol differs from the route protocol", async () => {
    const token = await makeToken();
    const upstreamId = await upstreamIdByName("up-anthropic");
    const res = await POST(
      req("/api/admin/named-routes", "POST", token, {
        name: "cheap",
        protocol: "openai",
        target: { upstreamId, targetModel: "claude-sonnet" },
      })
    );
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toContain("Protocol mismatch");
  });

  it("rejects an invalid protocol and an undeclared classifier model", async () => {
    const token = await makeToken();
    const classifierUpstreamId = await upstreamIdByName("up-classifier");
    expect(
      (await POST(req("/api/admin/named-routes", "POST", token, { name: "x", protocol: "grpc" }))).status
    ).toBe(400);
    const res = await POST(
      req("/api/admin/named-routes", "POST", token, {
        name: "x",
        protocol: "openai",
        classifierKind: "model",
        classifierUpstreamId,
        classifierModel: "not-declared",
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("not declared as a classifier");
  });

  it("accepts a declared LLM classifier and switches back to the rule classifier", async () => {
    const token = await makeToken();
    const classifierUpstreamId = await upstreamIdByName("up-classifier");
    const created = await POST(
      req("/api/admin/named-routes", "POST", token, {
        name: "smart",
        protocol: "openai",
        instruction: "pick by complexity",
        classifierKind: "model",
        classifierUpstreamId,
        classifierModel: "jev-latest",
      })
    );
    expect(created.status).toBe(201);
    const id = (await created.json()).data.id;

    const patched = await PATCH(
      req(`/api/admin/named-routes/${id}`, "PATCH", token, { classifierKind: "priority" }),
      await ctx(id)
    );
    expect(patched.status).toBe(200);

    const list = await GET(req("/api/admin/named-routes", "GET", token));
    const row = (await list.json()).data[0];
    expect(row.classifierKind).toBe("priority");
    expect(row.classifierUpstreamId).toBe(0);
    expect(row.classifierModel).toBe("");
    expect(row.instruction).toBe("pick by complexity");
  });

  it("deletes a named route together with its targets", async () => {
    const token = await makeToken();
    const upstreamId = await upstreamIdByName("up-openai");
    const created = await POST(
      req("/api/admin/named-routes", "POST", token, {
        name: "gone",
        protocol: "openai",
        target: { upstreamId, targetModel: "gpt-4o-mini" },
      })
    );
    const id = (await created.json()).data.id;

    const res = await DELETE(req(`/api/admin/named-routes/${id}`, "DELETE", token), await ctx(id));
    expect(res.status).toBe(200);
    const targets = await db.select().from(namedRouteTargetsTable);
    expect(targets).toHaveLength(0);
  });
});

describe("/api/admin/named-routes/[id]/targets", () => {
  async function createRoute(token: string): Promise<number> {
    const res = await POST(req("/api/admin/named-routes", "POST", token, { name: "cheap", protocol: "openai" }));
    return (await res.json()).data.id;
  }

  it("adds, edits and deletes a target", async () => {
    const token = await makeToken();
    const id = await createRoute(token);
    const upstreamId = await upstreamIdByName("up-openai");

    const added = await ADD_TARGET(
      req(`/api/admin/named-routes/${id}/targets`, "POST", token, {
        upstreamId,
        targetModel: "gpt-4o-mini",
        description: "cheap tier",
        priority: 2,
      }),
      await ctx(id)
    );
    expect(added.status).toBe(201);
    const targetId = (await added.json()).data.id;

    // 同 upstream + 同 model 重复 → 409
    expect(
      (
        await ADD_TARGET(
          req(`/api/admin/named-routes/${id}/targets`, "POST", token, { upstreamId, targetModel: "gpt-4o-mini" }),
          await ctx(id)
        )
      ).status
    ).toBe(409);

    const patched = await PATCH_TARGET(
      req(`/api/admin/named-routes/${id}/targets/${targetId}`, "PATCH", token, {
        targetModel: "gpt-4o",
        description: null,
        priority: 0,
      }),
      { params: { id: String(id), targetId: String(targetId) } }
    );
    expect(patched.status).toBe(200);

    const list = await GET(req("/api/admin/named-routes", "GET", token));
    expect((await list.json()).data[0].targets).toEqual([
      expect.objectContaining({ id: targetId, targetModel: "gpt-4o", description: null, priority: 0 }),
    ]);

    const removed = await DELETE_TARGET(
      req(`/api/admin/named-routes/${id}/targets/${targetId}`, "DELETE", token),
      { params: { id: String(id), targetId: String(targetId) } }
    );
    expect(removed.status).toBe(200);
    const after = await GET(req("/api/admin/named-routes", "GET", token));
    expect((await after.json()).data[0].targets).toEqual([]);
  });

  it("adds an auto target without upstreamId, lists it as (auto), and rejects duplicates with 409", async () => {
    const token = await makeToken();
    const id = await createRoute(token);

    const added = await ADD_TARGET(
      req(`/api/admin/named-routes/${id}/targets`, "POST", token, {
        targetModel: "claude-sonnet",
        description: "resolve by routing table",
      }),
      await ctx(id)
    );
    expect(added.status).toBe(201);
    const targetId = (await added.json()).data.id;

    // 同名 auto 目标重复 → 409（UNIQUE 索引对 NULL upstream_id 不去重，应用层查重）
    expect(
      (
        await ADD_TARGET(
          req(`/api/admin/named-routes/${id}/targets`, "POST", token, { targetModel: "claude-sonnet" }),
          await ctx(id)
        )
      ).status
    ).toBe(409);

    // 同名显式目标与 auto 目标不冲突（upstream 非 NULL 走 UNIQUE 索引）
    const upstreamId = await upstreamIdByName("up-openai");
    expect(
      (
        await ADD_TARGET(
          req(`/api/admin/named-routes/${id}/targets`, "POST", token, {
            upstreamId,
            targetModel: "claude-sonnet",
          }),
          await ctx(id)
        )
      ).status
    ).toBe(201);

    const list = await GET(req("/api/admin/named-routes", "GET", token));
    const targets = (await list.json()).data[0].targets;
    expect(targets).toEqual([
      expect.objectContaining({
        id: targetId,
        upstreamId: null,
        upstreamName: "(auto)",
        upstreamProtocol: null,
        targetModel: "claude-sonnet",
      }),
      expect.objectContaining({ upstreamId, upstreamName: "up-openai" }),
    ]);
  });

  it("rejects a target on an unknown route (404) and a protocol mismatch (400)", async () => {
    const token = await makeToken();
    const upstreamId = await upstreamIdByName("up-anthropic");
    expect(
      (
        await ADD_TARGET(
          req("/api/admin/named-routes/999/targets", "POST", token, { upstreamId, targetModel: "claude-sonnet" }),
          await ctx(999)
        )
      ).status
    ).toBe(404);

    const id = await createRoute(token);
    const res = await ADD_TARGET(
      req(`/api/admin/named-routes/${id}/targets`, "POST", token, { upstreamId, targetModel: "claude-sonnet" }),
      await ctx(id)
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("Protocol mismatch");
  });
});
