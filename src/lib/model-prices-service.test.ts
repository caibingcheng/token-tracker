import { resetSnapshotCache } from "@/lib/models-dev/snapshot";
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getModelPricesList, invalidateRemoteModelCache, RECENT_ACTIVITY_WINDOW_MS } from "./model-prices-service";
import { db, initDatabase, upstreamsTable, modelPricesTable, tokenRecords, syncInstancesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { eq } from "drizzle-orm";
import { setSetting } from "@/lib/auth/settings";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const UID = "u-0123456789abcdef0123456789abcdef";
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-visi-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
  // 空快照：避免 getSnapshot 拉网络（路径必须与 resolveSnapshotPath 一致，数据需结构合法）
  writeFileSync(
    join(dir, "models-dev-cache.json"),
    JSON.stringify({
      fetchedAt: new Date().toISOString(),
      source: "models.dev",
      data: { p1: { id: "p1", models: {} } },
    })
  );
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
    await db.delete(modelPricesTable);
    await db.delete(tokenRecords);
    await db.delete(upstreamsTable);
    await db.delete(syncInstancesTable);
  });
  await setSetting("models_dev_source", "models.dev");
  invalidateRemoteModelCache();
});

async function insertUpstream(name: string, models: string[]) {
  await withSkipCache(async () => {
    await db.insert(upstreamsTable).values({
      name,
      protocol: "openai",
      baseUrl: "https://example.com",
      enabledModels: JSON.stringify(models),
      priority: 0,
      enabled: 1,
    });
  });
}

async function insertRemoteRecord(model: string, createdAt: string, provider = "remote/bing-mbp/openai") {
  await withSkipCache(async () => {
    await db.insert(tokenRecords).values({
      model,
      provider,
      agent: "remote/bing-mbp/claude-code",
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      virtualKeyId: -1,
      remoteInstanceUid: UID,
      createdAt,
    });
  });
}

async function insertRemoteInstance(instanceName: string, lastRecordId = 5) {
  await withSkipCache(async () => {
    await db.insert(syncInstancesTable).values({
      uid: UID,
      instanceName,
      epoch: "e",
      lastRecordId,
      updatedAt: new Date().toISOString(),
    });
  });
}

async function insertPrice(
  model: string,
  opts: { source?: string; modelsDevId?: string | null } = {}
) {
  await withSkipCache(async () => {
    await db.insert(modelPricesTable).values({
      model,
      inputPrice: 1,
      outputPrice: 2,
      cacheReadPrice: null,
      cacheWritePrice: null,
      source: opts.source ?? "manual",
      modelsDevId: opts.modelsDevId ?? null,
      updatedAt: new Date().toISOString(),
    });
  });
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("model prices visibility (近期流量)", () => {
  it("row set includes pushed models (all history); recentActivity true within 30d", async () => {
    await insertRemoteInstance("bing-mbp");
    await insertRemoteRecord("push-recent", daysAgo(5));
    await insertRemoteRecord("push-old", daysAgo(60));

    const rows = await getModelPricesList();
    const recent = rows.find((r) => r.model === "push-recent");
    const old = rows.find((r) => r.model === "push-old");
    expect(recent).toBeDefined();
    expect(recent!.recentActivity).toBe(true);
    expect(recent!.upstreams).toContain("remote/bing-mbp/openai");
    expect(old).toBeDefined();
    expect(old!.recentActivity).toBe(false);
    // 行集全部来自推送（非本机 upstream）
    expect(recent!.status.active).toBe(false);
  });

  it("enabled upstream models are active; remote pushed models are not", async () => {
    await insertUpstream("up-a", ["gpt-4o"]);
    const rows = await getModelPricesList();
    const gpt = rows.find((r) => r.model === "gpt-4o");
    expect(gpt).toBeDefined();
    expect(gpt!.status.active).toBe(true);
    expect(gpt!.recentActivity).toBe(false);
  });

  it("no pushed history → row set is just upstream ∪ priced", async () => {
    await insertUpstream("up-a", ["gpt-4o"]);
    const rows = await getModelPricesList();
    expect(rows.map((r) => r.model)).toEqual(["gpt-4o"]);
  });

  it("推送模型 30 天前=inactive 且无近期流量；30 天内=近期流量（UI 默认可见）", async () => {
    await insertRemoteInstance("bing-mbp");
    await insertRemoteRecord("trojan-gpt", daysAgo(40));
    const rows = await getModelPricesList();
    const trojan = rows.find((r) => r.model === "trojan-gpt");
    expect(trojan).toBeDefined();
    expect(trojan!.recentActivity).toBe(false);
    // 默认可见性 = active ∪ recentActivity（40 天前的推送模型默认隐藏，showInactive 可查看）
    const visible = trojan!.status.active || trojan!.recentActivity;
    expect(visible).toBe(false);
  });

  it("RECENT_ACTIVITY_WINDOW_MS is 30 days", () => {
    expect(RECENT_ACTIVITY_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it("改名后历史行仍可被行集发现（uid 等值匹配，前缀失配不丢模型）", async () => {
    // 实例改名前推送的行：前缀还是旧名，remote_instance_uid 指向 uid
    await insertRemoteInstance("new-name");
    await insertRemoteRecord("renamed-model", daysAgo(5), "remote/old-name/openai");

    const rows = await getModelPricesList();
    const m = rows.find((r) => r.model === "renamed-model");
    expect(m).toBeDefined();
    expect(m!.recentActivity).toBe(true);
    expect(m!.upstreams).toContain("remote/old-name/openai");
  });

  it("legacy rows with uid NULL are still discovered via instance_name LIKE fallback", async () => {
    await insertRemoteInstance("bing-mbp");
    await withSkipCache(async () => {
      await db.insert(tokenRecords).values({
        model: "legacy-model",
        provider: "remote/bing-mbp/openai",
        agent: "remote/bing-mbp/claude-code",
        inputTokens: 1,
        outputTokens: 1,
        cacheRead: 0,
        cacheWrite: 0,
        virtualKeyId: -1,
        remoteInstanceUid: null, // 旧迁移前行
        createdAt: daysAgo(5),
      });
    });

    const rows = await getModelPricesList();
    const m = rows.find((r) => r.model === "legacy-model");
    expect(m).toBeDefined();
    expect(m!.upstreams).toContain("remote/bing-mbp/openai");
  });
});

describe("model prices badge semantics (inactive / removed)", () => {
  it("已定价的 remote 模型近 30 天有推送 → 不标 inactive（不再与默认可见性矛盾）", async () => {
    await insertRemoteInstance("bing-mbp");
    await insertRemoteRecord("push-recent", daysAgo(5));
    await insertPrice("push-recent");

    const rows = await getModelPricesList();
    const row = rows.find((r) => r.model === "push-recent")!;
    expect(row.status.active).toBe(false); // 不在本机 enabled_models
    expect(row.recentActivity).toBe(true);
    expect(row.status.inactive).toBe(false); // 不再误标 removed
  });

  it("已定价的 remote 模型 30 天前推送 → inactive（默认隐藏，Show removed 可查）", async () => {
    await insertRemoteInstance("bing-mbp");
    await insertRemoteRecord("push-stale", daysAgo(60));
    await insertPrice("push-stale");

    const rows = await getModelPricesList();
    const row = rows.find((r) => r.model === "push-stale")!;
    expect(row.recentActivity).toBe(false);
    expect(row.status.inactive).toBe(true);
    // 徽标与默认可见性（active ∪ recentActivity）严格互补
    expect(row.status.active || row.recentActivity).toBe(false);
  });

  it("已定价且不在 upstream、无流量 → inactive；在 upstream → active", async () => {
    await insertUpstream("up-a", ["live-model"]);
    await insertPrice("live-model");
    await insertPrice("dead-model");

    const rows = await getModelPricesList();
    expect(rows.find((r) => r.model === "live-model")!.status.inactive).toBe(false);
    expect(rows.find((r) => r.model === "dead-model")!.status.inactive).toBe(true);
  });

  it("跨快照源不判定 removed / hasUpdate（切源不误报已下架）", async () => {
    // 快照源 models.dev（beforeAll 写入），价格行来源 github → 不做任何比较
    await insertUpstream("up-a", ["cross-src"]);
    await insertPrice("cross-src", { source: "github", modelsDevId: "openai/gpt-4o" });

    const rows = await getModelPricesList();
    const row = rows.find((r) => r.model === "cross-src")!;
    expect(row.status.removed).toBe(false);
    expect(row.status.hasUpdate).toBe(false);
  });

  it("同源快照下快照无该 id → removed；同 id 价格不同 → hasUpdate", async () => {
    writeFileSync(
      join(dir, "models-dev-cache.json"),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        source: "github",
        data: {
          openai: {
            id: "openai",
            models: { "gpt-4o": { id: "gpt-4o", cost: { input: 5, output: 20 } } },
          },
        },
      })
    );
    resetSnapshotCache();
    try {
      await insertUpstream("up-a", ["gone-model", "changed-model"]);
      await insertPrice("gone-model", { source: "github", modelsDevId: "vanished/ghost-model" });
      await insertPrice("changed-model", { source: "github", modelsDevId: "openai/gpt-4o" });

      const rows = await getModelPricesList();
      const gone = rows.find((r) => r.model === "gone-model")!;
      const changed = rows.find((r) => r.model === "changed-model")!;
      expect(gone.status.removed).toBe(true);
      expect(gone.status.hasUpdate).toBe(false);
      expect(changed.status.removed).toBe(false);
      expect(changed.status.hasUpdate).toBe(true);
    } finally {
      // 恢复默认快照，避免污染后续测试
      writeFileSync(
        join(dir, "models-dev-cache.json"),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          source: "models.dev",
          data: { p1: { id: "p1", models: {} } },
        })
      );
      resetSnapshotCache();
    }
  });

  it("快照 id 仍在但为无价条目 → 不标 removed / hasUpdate（保留旧价）", async () => {
    writeFileSync(
      join(dir, "models-dev-cache.json"),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        source: "models.dev",
        // p1/no-price：id 仍在、cost 缺失（litellm 无价条目形态）；p1/vanished：确实不存在
        data: { p1: { id: "p1", models: { "no-price": { id: "no-price" } } } },
      })
    );
    resetSnapshotCache();
    try {
      await insertUpstream("up-a", ["costless", "vanished"]);
      await insertPrice("costless", { source: "models.dev", modelsDevId: "p1/no-price" });
      await insertPrice("vanished", { source: "models.dev", modelsDevId: "p1/vanished" });

      const rows = await getModelPricesList();
      const costless = rows.find((r) => r.model === "costless")!;
      const vanished = rows.find((r) => r.model === "vanished")!;
      expect(costless.status.removed).toBe(false);
      expect(costless.status.hasUpdate).toBe(false);
      expect(vanished.status.removed).toBe(true);
    } finally {
      writeFileSync(
        join(dir, "models-dev-cache.json"),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          source: "models.dev",
          data: { p1: { id: "p1", models: {} } },
        })
      );
      resetSnapshotCache();
    }
  });

  it("自动来源但 modelsDevId 为 null → 不判定 removed / hasUpdate", async () => {
    await insertUpstream("up-a", ["no-ref"]);
    await insertPrice("no-ref", { source: "models.dev", modelsDevId: null });

    const rows = await getModelPricesList();
    const row = rows.find((r) => r.model === "no-ref")!;
    expect(row.status.removed).toBe(false);
    expect(row.status.hasUpdate).toBe(false);
  });

  it("无快照（拉取失败）→ 没有 removed 误报（回归：旧实现会全表标下架）", async () => {
    const snapshotPath = join(dir, "models-dev-cache.json");
    const backup = readFileSync(snapshotPath, "utf-8");
    rmSync(snapshotPath, { force: true });
    resetSnapshotCache();
    vi.stubGlobal("fetch", async () => {
      throw new Error("network down");
    });
    try {
      await insertUpstream("up-a", ["snapshotless"]);
      await insertPrice("snapshotless", { source: "models.dev", modelsDevId: "p1/whatever" });

      const rows = await getModelPricesList();
      const row = rows.find((r) => r.model === "snapshotless")!;
      expect(row.status.removed).toBe(false);
      expect(row.status.hasUpdate).toBe(false);
      expect(row.status.active).toBe(true); // 已定价且在用，徽标不受快照缺失影响
    } finally {
      vi.unstubAllGlobals();
      writeFileSync(snapshotPath, backup);
      resetSnapshotCache();
    }
  });

  it("排序：inactive / removed 行统一排到末尾（active 的红 removed 行同样排末尾），组内按名 A→Z", async () => {
    await insertUpstream("up-a", ["bbb-live", "ddd-live", "fff-live-removed"]);
    await insertPrice("aaa-dead"); // inactive
    await insertPrice("ccc-stale", { source: "manual" }); // inactive
    await insertPrice("eee-snapshot-gone", {
      source: "github",
      modelsDevId: "vanished/ghost-model",
    });
    await insertPrice("fff-live-removed", {
      source: "github",
      modelsDevId: "vanished/ghost-model-2",
    });
    // 让 eee 成为 removed：写入 github 源快照（beforeAll 快照为 models.dev）
    writeFileSync(
      join(dir, "models-dev-cache.json"),
      JSON.stringify({
        fetchedAt: new Date().toISOString(),
        source: "github",
        data: { openai: { id: "openai", models: { "gpt-4o": { id: "gpt-4o", cost: { input: 1, output: 2 } } } } },
      })
    );
    resetSnapshotCache();
    try {
      const rows = await getModelPricesList();
      const live = rows.filter((r) => !r.status.inactive && !r.status.removed).map((r) => r.model);
      const gone = rows.filter((r) => r.status.inactive || r.status.removed).map((r) => r.model);
      expect(live).toEqual(["bbb-live", "ddd-live"]);
      expect(gone).toEqual(["aaa-dead", "ccc-stale", "eee-snapshot-gone", "fff-live-removed"]);
      // active 的红 removed 行：仍在用 → 默认可见（UI filter = active ∪ recentActivity），但排末尾
      const liveRemoved = rows.find((r) => r.model === "fff-live-removed")!;
      expect(liveRemoved.status.active).toBe(true);
      expect(liveRemoved.status.removed).toBe(true);
      expect(liveRemoved.status.inactive).toBe(false);
      // 失效行全部在末尾
      expect(rows.slice(0, live.length).every((r) => !r.status.inactive && !r.status.removed)).toBe(true);
      expect(rows.slice(live.length).every((r) => r.status.inactive || r.status.removed)).toBe(true);
      expect(rows.some((r) => r.status.removed)).toBe(true);
    } finally {
      writeFileSync(
        join(dir, "models-dev-cache.json"),
        JSON.stringify({
          fetchedAt: new Date().toISOString(),
          source: "models.dev",
          data: { p1: { id: "p1", models: {} } },
        })
      );
      resetSnapshotCache();
    }
  });
});