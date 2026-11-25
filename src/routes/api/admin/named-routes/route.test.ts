import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET, POST } from "./route";
import { PATCH, DELETE } from "./[id]/route";
import { POST as ADD_TARGET } from "./[id]/targets/route";
import { PATCH as PATCH_TARGET, DELETE as DELETE_TARGET } from "./[id]/targets/[targetId]/route";
import { closeDb, db, initDatabase, namedRouteTargetsTable, namedRoutesTable, upstreamsTable } from "@/lib/db";
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
  closeDb();
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
      {
        name: "up-chat-cls",
        protocol: "anthropic",
        baseUrl: "https://d.example",
        classifierModels: JSON.stringify([{ model: "claude-decider", type: "chat" }]),
      },
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

  it("rejects a duplicate name with 409 (name 是全局唯一键)", async () => {
    const token = await makeToken();
    const body = { name: "cheap" };
    expect((await POST(req("/api/admin/named-routes", "POST", token, body))).status).toBe(201);
    expect((await POST(req("/api/admin/named-routes", "POST", token, body))).status).toBe(409);
  });

  it("accepts a target on an upstream that serves another face (hop 过滤由 protocols 决定)", async () => {
    const token = await makeToken();
    const upstreamId = await upstreamIdByName("up-anthropic");
    const res = await POST(
      req("/api/admin/named-routes", "POST", token, {
        name: "cheap",
        target: { upstreamId, targetModel: "claude-sonnet" },
      })
    );
    expect(res.status).toBe(201);
    const json = await res.json();
    // target 的接受面透出给 UI（供展示/诊断）
    const list = await GET(req("/api/admin/named-routes", "GET", token));
    const row = (await list.json()).data[0];
    expect(row.name).toBe(json.data.name);
    expect(row.targets[0].upstreamProtocols).toContain("anthropic");
    expect(row.targets[0].upstreamAuthStyle).toBe("x-api-key");
  });

  it("accepts any model as classifier; rejects a declared chat classifier on non-openai upstream", async () => {
    const token = await makeToken();
    const classifierUpstreamId = await upstreamIdByName("up-classifier");
    const chatClsUpstreamId = await upstreamIdByName("up-chat-cls");
    // 未声明的模型也可作分类器（运行时默认 jev-systemone）
    const accepted = await POST(
      req("/api/admin/named-routes", "POST", token, {
        name: "x",
        classifierKind: "model",
        classifierUpstreamId,
        classifierModel: "not-declared",
      })
    );
    expect(accepted.status).toBe(201);
    // 存量声明为 chat 的分类器仍要求 openai 协议 upstream
    const res = await POST(
      req("/api/admin/named-routes", "POST", token, {
        name: "y",
        classifierKind: "model",
        classifierUpstreamId: chatClsUpstreamId,
        classifierModel: "claude-decider",
      })
    );
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("openai-protocol");
  });

  it("accepts a declared LLM classifier and switches back to the rule classifier", async () => {
    const token = await makeToken();
    const classifierUpstreamId = await upstreamIdByName("up-classifier");
    const created = await POST(
      req("/api/admin/named-routes", "POST", token, {
        name: "smart",
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

  it("renames a named route and rejects a name collision", async () => {
    const token = await makeToken();
    const created = await POST(
      req("/api/admin/named-routes", "POST", token, { name: "cheap" })
    );
    const id = (await created.json()).data.id;
    expect(
      (await POST(req("/api/admin/named-routes", "POST", token, { name: "taken" }))).status
    ).toBe(201);

    const renamed = await PATCH(
      req(`/api/admin/named-routes/${id}`, "PATCH", token, { name: "  fast  " }),
      await ctx(id)
    );
    expect(renamed.status).toBe(200);

    const list = await GET(req("/api/admin/named-routes", "GET", token));
    const names = (await list.json()).data.map((r: any) => r.name).sort();
    expect(names).toEqual(["fast", "taken"]);

    // 重名 → 409，原值不变
    const conflict = await PATCH(
      req(`/api/admin/named-routes/${id}`, "PATCH", token, { name: "taken" }),
      await ctx(id)
    );
    expect(conflict.status).toBe(409);
    const after = await db.select().from(namedRoutesTable);
    expect((after.find((r: any) => r.id === id) as any).name).toBe("fast");

    // 空名 / 超长名 → 400
    expect(
      (await PATCH(req(`/api/admin/named-routes/${id}`, "PATCH", token, { name: "   " }), await ctx(id))).status
    ).toBe(400);
    expect(
      (
        await PATCH(
          req(`/api/admin/named-routes/${id}`, "PATCH", token, { name: "n".repeat(257) }),
          await ctx(id)
        )
      ).status
    ).toBe(400);
  });

  it("treats a same-name patch as a no-op and keeps name globally unique", async () => {
    const token = await makeToken();
    const created = await POST(
      req("/api/admin/named-routes", "POST", token, { name: "immutable" })
    );
    const id = (await created.json()).data.id;

    // 同名提交：合法 no-op → 200
    expect(
      (await PATCH(req(`/api/admin/named-routes/${id}`, "PATCH", token, { name: "immutable" }), await ctx(id)))
        .status
    ).toBe(200);

    // 只提交无字段 → 400
    expect(
      (await PATCH(req(`/api/admin/named-routes/${id}`, "PATCH", token, {}), await ctx(id))).status
    ).toBe(400);

    // 改名为已存在的 name → 409
    await POST(req("/api/admin/named-routes", "POST", token, { name: "taken-name" }));
    expect(
      (
        await PATCH(
          req(`/api/admin/named-routes/${id}`, "PATCH", token, { name: "taken-name" }),
          await ctx(id)
        )
      ).status
    ).toBe(409);
    const list = await GET(req("/api/admin/named-routes", "GET", token));
    const row = (await list.json()).data.find((r: any) => r.id === id);
    expect(row.name).toBe("immutable");
  });

  it("deletes a named route together with its targets", async () => {
    const token = await makeToken();
    const upstreamId = await upstreamIdByName("up-openai");
    const created = await POST(
      req("/api/admin/named-routes", "POST", token, {
        name: "gone",
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
    const res = await POST(req("/api/admin/named-routes", "POST", token, { name: "cheap" }));
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

  it("rejects a target on an unknown route (404) but accepts a cross-family upstream (decoupled)", async () => {
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

    const id = await createRoute(token); // createRoute 建的是 openai 路由
    const res = await ADD_TARGET(
      req(`/api/admin/named-routes/${id}/targets`, "POST", token, { upstreamId, targetModel: "claude-sonnet" }),
      await ctx(id)
    );
    expect(res.status).toBe(201);
    // 返回原始 target 行（列名 upstream_model → upstreamModel）
    expect((await res.json()).data).toEqual(
      expect.objectContaining({ upstreamId, upstreamModel: "claude-sonnet" })
    );
  });
});
