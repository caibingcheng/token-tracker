import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET as dashboardGET } from "./route";
import { db, initDatabase, tokenRecords } from "@/lib/db";
import {
  setAdminApiKey,
  getTokenEpoch,
  deleteSetting,
} from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";
import { aggregateProviders } from "@/lib/provider-stats";
import { emptyAggregatedCost, type AggregatedCost } from "@/lib/cost-utils";
import type { HiddenProviderGroup } from "@/lib/provider-utils";

interface RowInput {
  group: string;
  model: string;
  provider?: string;
  totalInput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalOutput: number;
  totalCacheWrite: number;
  count: number;
  cost?: AggregatedCost;
}

function makeRow(overrides: Partial<RowInput> & { provider?: string }): RowInput {
  return {
    group: "2026-08-01",
    model: "gpt-4o",
    totalInput: 1000,
    totalInputCached: 200,
    totalInputUncached: 800,
    totalOutput: 500,
    totalCacheWrite: 0,
    count: 2,
    ...overrides,
  };
}

function makeCost(totalCost: number): AggregatedCost {
  return { ...emptyAggregatedCost(), totalCost };
}

const HIDDEN_GROUPS: HiddenProviderGroup[] = [
  { name: "Provider A", letter: "A", patterns: ["openai"] },
];

describe("aggregateProviders", () => {
  it("按 provider 合并 token 与 count", () => {
    const rows = [
      makeRow({
        provider: "openai",
        group: "2026-08-01",
        totalInput: 100,
        totalInputCached: 30,
        totalOutput: 50,
        count: 3,
      }),
      makeRow({
        provider: "openai",
        group: "2026-08-02",
        totalInput: 200,
        totalInputCached: 60,
        totalOutput: 70,
        count: 4,
      }),
      makeRow({
        provider: "anthropic",
        group: "2026-08-01",
        totalInput: 400,
        totalInputCached: 100,
        totalOutput: 90,
        count: 5,
      }),
    ];
    const result = aggregateProviders(rows, []);
    expect(result).toHaveLength(2);

    const openai = result.find((r) => r.provider === "openai")!;
    expect(openai.totalInput).toBe(300);
    expect(openai.totalInputCached).toBe(90);
    expect(openai.totalOutput).toBe(120);
    expect(openai.count).toBe(7);
    expect(openai.providerName).toBe("openai");

    const anthropic = result.find((r) => r.provider === "anthropic")!;
    expect(anthropic.totalInput).toBe(400);
    expect(anthropic.count).toBe(5);
  });

  it("cost 经 mergeAggregatedCosts 合并", () => {
    const rows = [
      makeRow({ provider: "openai", cost: makeCost(1.5) }),
      makeRow({ provider: "openai", cost: makeCost(2.5) }),
    ];
    const result = aggregateProviders(rows, []);
    expect(result).toHaveLength(1);
    expect(result[0].totalCost).toBe(4);
  });

  it("无 cost 行 totalCost = 0", () => {
    const result = aggregateProviders([makeRow({ provider: "openai" })], []);
    expect(result).toHaveLength(1);
    expect(result[0].totalCost).toBe(0);
  });

  it("遵守 hidden_providers 匿名化并归并同组 provider", () => {
    const rows = [
      makeRow({ provider: "openai" }),
      makeRow({ provider: "anthropic" }),
    ];
    const result = aggregateProviders(rows, HIDDEN_GROUPS);
    // 归并后 provider 字段本身即为组名，与 providerName 一致
    expect(result.find((r) => r.provider === "Provider A")!.providerName).toBe(
      "Provider A"
    );
    expect(result.find((r) => r.provider === "anthropic")!.providerName).toBe(
      "anthropic"
    );
  });

  it("不截断：超过 5 个 provider 全部返回", () => {
    const rows = ["p1", "p2", "p3", "p4", "p5", "p6"].map((provider, i) =>
      makeRow({ provider, totalInput: 100 - i })
    );
    const result = aggregateProviders(rows, []);
    expect(result).toHaveLength(6);
  });

  it("按 totalInput 降序", () => {
    const rows = [
      makeRow({ provider: "a", totalInput: 10 }),
      makeRow({ provider: "b", totalInput: 50 }),
      makeRow({ provider: "c", totalInput: 30 }),
    ];
    const result = aggregateProviders(rows, []);
    expect(result.map((r) => r.provider)).toEqual(["b", "c", "a"]);
  });

  it("provider 缺失回退 unknown", () => {
    const result = aggregateProviders([makeRow({ provider: undefined })], []);
    expect(result).toHaveLength(1);
    expect(result[0].provider).toBe("unknown");
    expect(result[0].providerName).toBe("unknown");
  });

  it("空输入返回空数组", () => {
    expect(aggregateProviders([], [])).toEqual([]);
  });
});

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-dashboard-route-"));
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
  await deleteSetting("agent_aliases").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "GET",
    headers: { "x-api-key": token ?? "" },
  });
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
      userAgent: overrides.userAgent ?? null,
      createdAt: overrides.createdAt ?? new Date().toISOString(),
    });
  });
}

describe("dashboard route agent filter（UA 反找）", () => {
  it("未认证 401", async () => {
    const res = await dashboardGET(req("/api/dashboard"));
    expect(res.status).toBe(401);
  });

  it("agent 参数按派生工具名反找：只统计对应 UA 的记录", async () => {
    await insertRecord({ agent: "vk-a", userAgent: "claude-cli/2.1.5 (external, cli)", inputTokens: 100 });
    await insertRecord({ agent: "vk-b", userAgent: "opencode/1.18.14", inputTokens: 300 });
    await insertRecord({ agent: "vk-c", userAgent: null, inputTokens: 500 });

    const token = await makeToken();
    const res = await dashboardGET(req("/api/dashboard?range=30d&agent=claude-code", token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.total[0].totalInput).toBe(100);
    expect(json.data.total[0].count).toBe(1);
  });

  it("agent=unknown 走 IS NULL user_agent 条件", async () => {
    await insertRecord({ agent: "vk-a", userAgent: "claude-cli/2.1.5 (external, cli)" });
    await insertRecord({ agent: "vk-c", userAgent: null, inputTokens: 500 });

    const token = await makeToken();
    const res = await dashboardGET(req("/api/dashboard?range=30d&agent=unknown", token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.total[0].totalInput).toBe(500);
    expect(json.data.total[0].count).toBe(1);
  });

  it("未知 agent → 400", async () => {
    await insertRecord({ agent: "vk-a", userAgent: "claude-cli/2.1.5 (external, cli)" });
    const token = await makeToken();
    const res = await dashboardGET(req("/api/dashboard?range=30d&agent=nonexistent", token));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.error).toBe("Unknown agent: nonexistent");
  });
});
