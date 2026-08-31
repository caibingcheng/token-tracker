import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET, PUT, DELETE } from "./route";
import { POST as selectPOST } from "./select/route";
import { POST as autofillPOST } from "./auto-fill/route";
import { db, initDatabase, upstreamsTable, modelPricesTable } from "@/lib/db";
import { eq } from "drizzle-orm";
import {
  setAdminApiKey,
  getTokenEpoch,
  deleteSetting,
} from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";
import { resetSnapshotCache } from "@/lib/models-dev/snapshot";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;

const ADMIN_KEY = "test-admin-key-123456";


let dir: string;
let snapshotPath: string;

const SNAPSHOT = {
  fetchedAt: "2026-08-01T00:00:00.000Z",
  data: {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-sonnet-4-6": {
          id: "claude-sonnet-4-6",
          cost: { input: 3, output: 15, cache_read: 0.3 },
          last_updated: "2026-07-01",
        },
      },
    },
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

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-mp-route-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
  snapshotPath = join(dir, "models-dev-cache.json");
  writeFileSync(snapshotPath, JSON.stringify(SNAPSHOT), "utf-8");
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
    await db.delete(upstreamsTable);
    await db.delete(modelPricesTable);
  });
  await deleteSetting("token_epoch").catch(() => {});
  await deleteSetting("model_aliases").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
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

async function insertUpstream(overrides: Partial<any> = {}) {
  await withSkipCache(async () => {
    await db.insert(upstreamsTable).values({
      name: overrides.name ?? "up-a",
      protocol: overrides.protocol ?? "openai",
      baseUrl: overrides.baseUrl ?? "https://example.com",
      enabledModels: JSON.stringify(overrides.enabledModels ?? ["gpt-4o", "claude-sonnet-4-6"]),
      enabled: 1,
      priority: 0,
    });
  });
}

async function getRows(): Promise<any[]> {
  const token = await makeToken();
  const res = await json(await GET(req("/api/admin/model-prices", "GET", undefined, token), { params: {} } as any) as any);
  return res.data;
}

describe("model-prices admin routes", () => {
  it("rejects unauthenticated requests with 401", async () => {
    const res = await GET(req("/api/admin/model-prices", "GET"));
    expect(res.status).toBe(401);
  });

  it("GET: row set = enabled_models ∪ priced models with active/inactive status", async () => {
    await insertUpstream();
    // 定价一个不在 enabled_models 中的 model（inactive）
    const token = await makeToken();
    await json(await PUT(req("/api/admin/model-prices", "PUT", {
      model: "legacy-model",
      inputPrice: 1,
      outputPrice: 2,
    }, token)));

    const rows = await getRows();
    const byModel = new Map(rows.map((r) => [r.model, r]));
    expect(byModel.has("gpt-4o")).toBe(true);
    expect(byModel.has("claude-sonnet-4-6")).toBe(true);
    expect(byModel.has("legacy-model")).toBe(true);

    expect(byModel.get("gpt-4o").status.active).toBe(true);
    expect(byModel.get("gpt-4o").status.inactive).toBe(false);
    expect(byModel.get("gpt-4o").source).toBeNull();
    expect(byModel.get("gpt-4o").upstreams).toEqual(["up-a"]);

    expect(byModel.get("legacy-model").status.active).toBe(false);
    expect(byModel.get("legacy-model").status.inactive).toBe(true);
    expect(byModel.get("legacy-model").source).toBe("manual");
    expect(byModel.get("legacy-model").inputPrice).toBe(1);
    expect(byModel.get("legacy-model").outputPrice).toBe(2);
  });

  it("PUT: manual edit sets source=manual and clears modelsDevId; model names with slash work", async () => {
    const token = await makeToken();
    // 先落一个 models.dev 来源的价格（select）
    const sel = await json(await selectPOST(req("/api/admin/model-prices/select", "POST", {
      model: "gpt-4o",
      modelsDevId: "openai/gpt-4o",
    }, token)));
    expect(sel.success).toBe(true);

    const modelWithSlash = "siliconflow-cn/Qwen/Qwen3.5-4B";
    const put = await json(await PUT(req("/api/admin/model-prices", "PUT", {
      model: modelWithSlash,
      inputPrice: 0.5,
      outputPrice: 1.5,
      cacheReadPrice: null,
      cacheWritePrice: null,
    }, token)));
    expect(put.success).toBe(true);

    // gpt-4o 被手动覆盖 → source=manual 且清空 modelsDevId
    await json(await PUT(req("/api/admin/model-prices", "PUT", {
      model: "gpt-4o",
      inputPrice: 2.25,
      outputPrice: 9,
    }, token)));

    const rows = await getRows();
    const byModel = new Map(rows.map((r) => [r.model, r]));
    expect(byModel.get("gpt-4o").source).toBe("manual");
    expect(byModel.get("gpt-4o").modelsDevId).toBeNull();
    expect(byModel.get("gpt-4o").sourceProvider).toBeNull();
    expect(byModel.get("gpt-4o").inputPrice).toBe(2.25);
    expect(byModel.get("siliconflow-cn/Qwen/Qwen3.5-4B").source).toBe("manual");
    expect(byModel.get("siliconflow-cn/Qwen/Qwen3.5-4B").inputPrice).toBe(0.5);
  });

  it("GET: hasUpdate badge with diff when models.dev price differs from snapshot", async () => {
    const token = await makeToken();
    await json(await selectPOST(req("/api/admin/model-prices/select", "POST", {
      model: "gpt-4o",
      modelsDevId: "openai/gpt-4o",
    }, token)));
    // 篡改价格模拟上游改价
    await json(await PUT(req("/api/admin/model-prices", "PUT", {
      model: "gpt-4o",
      inputPrice: 99,
      outputPrice: 99,
    }, token)));

    // 手动覆盖后 source=manual，不再显示 hasUpdate
    const rows = await getRows();
    const row = rows.find((r) => r.model === "gpt-4o");
    expect(row.source).toBe("manual");
    expect(row.status.hasUpdate).toBe(false);

    // 重新 select（恢复 models.dev 来源），再直接改 DB 价格模拟快照外新价
    await json(await selectPOST(req("/api/admin/model-prices/select", "POST", {
      model: "gpt-4o",
      modelsDevId: "openai/gpt-4o",
    }, token)));
    await withSkipCache(async () => {
      await db.update(modelPricesTable)
        .set({ inputPrice: 7.5, outputPrice: 30 })
        .where(eq(modelPricesTable.model, "gpt-4o"));
    });
    const rows2 = await getRows();
    const row2 = rows2.find((r) => r.model === "gpt-4o");
    expect(row2.status.hasUpdate).toBe(true);
    expect(row2.status.diff).toEqual({
      inputPrice: 2.5,
      outputPrice: 10,
      cacheReadPrice: null,
      cacheWritePrice: null,
    });
  });

  it("GET: removed badge when models.dev id no longer in snapshot", async () => {
    const token = await makeToken();
    await json(await selectPOST(req("/api/admin/model-prices/select", "POST", {
      model: "claude-sonnet-4-6",
      modelsDevId: "anthropic/claude-sonnet-4-6",
    }, token)));
    // 手动把 modelsDevId 改成不存在的
    await withSkipCache(async () => {
      await db.update(modelPricesTable)
        .set({ modelsDevId: "vanished/ghost-model" })
        .where(eq(modelPricesTable.model, "claude-sonnet-4-6"));
    });
    const rows = await getRows();
    const row = rows.find((r) => r.model === "claude-sonnet-4-6");
    expect(row.status.removed).toBe(true);
    expect(row.status.hasUpdate).toBe(false);
    // 快照无该 provider → sourceProvider 回退 providerId
    expect(row.sourceProvider).toBe("vanished");
  });

  it("GET: pending (multi-candidate with differing prices) and unmatched badges", async () => {
    const token = await makeToken();
    await insertUpstream();
    // 快照里只有一个 openai/gpt-4o 候选 → 非 pending
    const rows = await getRows();
    const gpt = rows.find((r) => r.model === "gpt-4o");
    expect(gpt.status.unmatched).toBe(false);
    expect(gpt.status.pending).toBe(false);
    // claude-sonnet-4-6 快照中有（anthropic）→ 已匹配（唯一候选，无冲突）
    const unknown = rows.find((r) => r.model === "claude-sonnet-4-6");
    expect(unknown.status.pending).toBe(false);
    // 修改快照：加入一个不同价同名的 meta 候选 → pending
    const withConflict = {
      fetchedAt: SNAPSHOT.fetchedAt,
      data: {
        ...SNAPSHOT.data,
        meta: {
          id: "meta",
          name: "Meta",
          models: {
            "claude-sonnet-4-6": {
              id: "claude-sonnet-4-6",
              cost: { input: 1, output: 4 },
            },
          },
        },
      },
    };
    writeFileSync(snapshotPath, JSON.stringify(withConflict), "utf-8");
    resetSnapshotCache();
    const rows2 = await getRows();
    const row2 = rows2.find((r) => r.model === "claude-sonnet-4-6");
    expect(row2.status.pending).toBe(true);
    expect(row2.status.unmatched).toBe(false);
    // 恢复快照，避免污染后续测试
    writeFileSync(snapshotPath, JSON.stringify(SNAPSHOT), "utf-8");
    resetSnapshotCache();
  });

  it("DELETE removes price row", async () => {
    const token = await makeToken();
    await insertUpstream({ enabledModels: ["gpt-4o"] });
    await json(await PUT(req("/api/admin/model-prices", "PUT", {
      model: "gpt-4o",
      inputPrice: 1,
      outputPrice: 2,
    }, token)));
    const del = await json(await DELETE(req("/api/admin/model-prices?model=gpt-4o", "DELETE", undefined, token)));
    expect(del.success).toBe(true);
    const rows = await getRows();
    const gpt = rows.find((r) => r.model === "gpt-4o");
    // 价格行已删除：行仍在（upstream 提供）但无价格
    expect(gpt.source).toBeNull();
    expect(gpt.inputPrice).toBeNull();
    // 再删一次 → 404
    const del2 = await DELETE(req("/api/admin/model-prices?model=gpt-4o", "DELETE", undefined, token));
    expect(del2.status).toBe(404);
  });

  it("select: writes from snapshot candidate with source=models.dev", async () => {
    const token = await makeToken();
    const res = await json(await selectPOST(req("/api/admin/model-prices/select", "POST", {
      model: "gpt-4o",
      modelsDevId: "openai/gpt-4o",
    }, token)));
    expect(res.success).toBe(true);

    const rows = await getRows();
    const gpt = rows.find((r) => r.model === "gpt-4o");
    expect(gpt.source).toBe("models.dev");
    expect(gpt.modelsDevId).toBe("openai/gpt-4o");
    expect(gpt.sourceProvider).toBe("OpenAI");
    expect(gpt.inputPrice).toBe(2.5);
    expect(gpt.outputPrice).toBe(10);
  });

  it("select: allows snapshot entry whose name does not match the model (search pick)", async () => {
    const token = await makeToken();
    // zzz-not-matching 在匹配管线中无候选，但 openai/gpt-4o 存在于快照 → 允许
    const res = await json(await selectPOST(req("/api/admin/model-prices/select", "POST", {
      model: "zzz-not-matching",
      modelsDevId: "openai/gpt-4o",
    }, token)));
    expect(res.success).toBe(true);

    const rows = await getRows();
    const row = rows.find((r) => r.model === "zzz-not-matching");
    expect(row.source).toBe("models.dev");
    expect(row.modelsDevId).toBe("openai/gpt-4o");
    expect(row.sourceProvider).toBe("OpenAI");
    expect(row.inputPrice).toBe(2.5);
    expect(row.outputPrice).toBe(10);
  });

  it("select: rejects candidate not in snapshot (tamper protection)", async () => {
    const token = await makeToken();
    const res = await json(await selectPOST(req("/api/admin/model-prices/select", "POST", {
      model: "gpt-4o",
      modelsDevId: "evil/hacked",
    }, token)));
    expect(res.success).toBe(false);
    expect(res.error).toContain("Candidate not found");
  });

  it("auto-fill: fills unpriced rows only, never touches manual rows", async () => {
    const token = await makeToken();
    await insertUpstream({ enabledModels: ["gpt-4o", "claude-sonnet-4-6", "no-candidate-model"] });
    // manual 行
    await json(await PUT(req("/api/admin/model-prices", "PUT", {
      model: "gpt-4o",
      inputPrice: 1.11,
      outputPrice: 2.22,
    }, token)));

    const res = await json(await autofillPOST(req("/api/admin/model-prices/auto-fill", "POST", undefined, token)));
    expect(res.success).toBe(true);
    expect(res.data.filled).toEqual(["claude-sonnet-4-6"]);
    expect(res.data.updated).toEqual([]);
    expect(res.data.skipped).toEqual(["gpt-4o"]);
    expect(res.data.unmatched).toEqual(["no-candidate-model"]);

    const rows = await getRows();
    const byModel = new Map(rows.map((r) => [r.model, r]));
    // manual 行未被覆盖
    expect(byModel.get("gpt-4o").inputPrice).toBe(1.11);
    expect(byModel.get("gpt-4o").source).toBe("manual");
    // models.dev 行
    expect(byModel.get("claude-sonnet-4-6").source).toBe("models.dev");
    expect(byModel.get("claude-sonnet-4-6").inputPrice).toBe(3);
    expect(byModel.get("claude-sonnet-4-6").modelsDevId).toBe("anthropic/claude-sonnet-4-6");
  });

  it("auto-fill force: overwrites models.dev rows, skips manual rows, fills & counts updated", async () => {
    const token = await makeToken();
    // claude-sonnet-4-6 先手动写成非官方价（模拟混源污染，source=manual 保护）
    await insertUpstream({ enabledModels: ["gpt-4o", "claude-sonnet-4-6"] });
    await json(await PUT(req("/api/admin/model-prices", "PUT", {
      model: "claude-sonnet-4-6",
      inputPrice: 99,
      outputPrice: 99,
    }, token)));
    // gpt-4o 先用 models.dev 价写旧价（非 manual，可覆盖）
    await json(await selectPOST(req("/api/admin/model-prices/select", "POST", {
      model: "gpt-4o",
      modelsDevId: "openai/gpt-4o",
    }, token)));

    const res = await json(await autofillPOST(
      req("/api/admin/model-prices/auto-fill", "POST", { mode: "force" }, token)
    ));
    expect(res.success).toBe(true);
    expect(res.data.updated).toEqual(["gpt-4o"]);
    expect(res.data.filled).toEqual([]);
    expect(res.data.skipped).toEqual(["claude-sonnet-4-6"]);
    // gpt-4o 与 SNAPSHOT 快照同价（2.5/10）→ updated 已记但价格一致；manual 行价格保持
    const rows = await getRows();
    const byModel = new Map(rows.map((r) => [r.model, r]));
    expect(byModel.get("claude-sonnet-4-6").inputPrice).toBe(99);
    expect(byModel.get("claude-sonnet-4-6").source).toBe("manual");
    expect(byModel.get("gpt-4o").source).toBe("models.dev");
    expect(byModel.get("gpt-4o").modelsDevId).toBe("openai/gpt-4o");
  });

  it("auto-fill force: rejects unknown mode (400)", async () => {
    const token = await makeToken();
    const res = await autofillPOST(
      req("/api/admin/model-prices/auto-fill", "POST", { mode: "super-force" }, token)
    );
    expect(res.status).toBe(400);
  });
});
