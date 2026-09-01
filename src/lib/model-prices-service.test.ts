import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getModelPricesList, invalidateRemoteModelCache, RECENT_ACTIVITY_WINDOW_MS } from "./model-prices-service";
import { db, initDatabase, upstreamsTable, modelPricesTable, tokenRecords, syncInstancesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { eq } from "drizzle-orm";
import { setSetting } from "@/lib/auth/settings";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-visi-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
  // 空快照：避免 getSnapshot 拉网络
  writeFileSync(join(dir, "snapshot.json"), JSON.stringify({ fetchedAt: new Date().toISOString(), data: {} }));
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

async function insertRemoteRecord(model: string, createdAt: string) {
  await withSkipCache(async () => {
    await db.insert(tokenRecords).values({
      model,
      provider: "remote/bing-mbp/openai",
      agent: "remote/bing-mbp/claude-code",
      inputTokens: 1,
      outputTokens: 1,
      cacheRead: 0,
      cacheWrite: 0,
      virtualKeyId: -1,
      createdAt,
    });
  });
}

const daysAgo = (n: number) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

describe("model prices visibility (近期流量)", () => {
  it("row set includes pushed models (all history); recentActivity true within 30d", async () => {
    await withSkipCache(async () => {
      await db.insert(syncInstancesTable).values({ instance: "bing-mbp", epoch: "e", lastRecordId: 5, updatedAt: new Date().toISOString() });
    });
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
    await withSkipCache(async () => {
      await db.insert(syncInstancesTable).values({ instance: "bing-mbp", epoch: "e", lastRecordId: 5, updatedAt: new Date().toISOString() });
    });
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
});