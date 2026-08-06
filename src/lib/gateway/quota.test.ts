import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { checkQuota } from "./quota";
import type { QuotaCheckInput, QuotaUsage } from "./quota";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

describe("checkQuota", () => {
  const now = new Date("2026-08-06T12:00:00Z");

  function mkInput(overrides: Partial<QuotaCheckInput> = {}): QuotaCheckInput {
    return {
      virtualKeyId: 1,
      maxRpm: null,
      maxTpm: null,
      maxDailyTokens: null,
      maxMonthlyTokens: null,
      now,
      ...overrides,
    };
  }

  const zeroUsage: QuotaUsage = { rpm: 0, tpm: 0, dailyTokens: 0, monthlyTokens: 0 };

  it("never violates when all limits are null", () => {
    expect(checkQuota(mkInput(), { rpm: 999, tpm: 999999, dailyTokens: 99999999, monthlyTokens: 999999999 })).toBeNull();
  });

  it("detects single-dimension violations", () => {
    const usage: QuotaUsage = { rpm: 100, tpm: 1000, dailyTokens: 10000, monthlyTokens: 100000 };
    expect(checkQuota(mkInput({ maxRpm: 50 }), usage)).toEqual({
      dimension: "max_rpm",
      current: 100,
      limit: 50,
    });
    expect(checkQuota(mkInput({ maxTpm: 500 }), usage)).toEqual({
      dimension: "max_tpm",
      current: 1000,
      limit: 500,
    });
    expect(checkQuota(mkInput({ maxDailyTokens: 5000 }), usage)).toEqual({
      dimension: "max_daily_tokens",
      current: 10000,
      limit: 5000,
    });
    expect(checkQuota(mkInput({ maxMonthlyTokens: 50000 }), usage)).toEqual({
      dimension: "max_monthly_tokens",
      current: 100000,
      limit: 50000,
    });
  });

  it("returns first violation by priority rpm → tpm → daily → monthly", () => {
    const usage: QuotaUsage = { rpm: 100, tpm: 1000, dailyTokens: 10000, monthlyTokens: 100000 };
    const input = mkInput({
      maxRpm: 50,
      maxTpm: 500,
      maxDailyTokens: 5000,
      maxMonthlyTokens: 50000,
    });
    expect(checkQuota(input, usage)?.dimension).toBe("max_rpm");

    const noRpm = mkInput({
      maxTpm: 500,
      maxDailyTokens: 5000,
      maxMonthlyTokens: 50000,
    });
    expect(checkQuota(noRpm, usage)?.dimension).toBe("max_tpm");

    const noRpmNoTpm = mkInput({
      maxDailyTokens: 5000,
      maxMonthlyTokens: 50000,
    });
    expect(checkQuota(noRpmNoTpm, usage)?.dimension).toBe("max_daily_tokens");

    const onlyMonthly = mkInput({ maxMonthlyTokens: 50000 });
    expect(checkQuota(onlyMonthly, usage)?.dimension).toBe("max_monthly_tokens");
  });

  it("allows boundary current === limit", () => {
    const usage: QuotaUsage = { rpm: 60, tpm: 1000, dailyTokens: 10000, monthlyTokens: 100000 };
    expect(checkQuota(mkInput({ maxRpm: 60 }), usage)).toBeNull();
    expect(checkQuota(mkInput({ maxTpm: 1000 }), usage)).toBeNull();
    expect(checkQuota(mkInput({ maxDailyTokens: 10000 }), usage)).toBeNull();
    expect(checkQuota(mkInput({ maxMonthlyTokens: 100000 }), usage)).toBeNull();
  });
});

describe("quota loadUsage (DB-backed)", () => {
  let dir: string;
  let dbPath: string;
  let createProxyDeps: typeof import("./proxy-deps").createProxyDeps;
  let virtualKeysTable: any;
  let tokenRecords: any;
  let db: any;

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "tt-quota-"));
    dbPath = join(dir, "quota.db");
    process.env.SQLITE_DATABASE_PATH = dbPath;
    const dbModule = await import("@/lib/db");
    await dbModule.initDatabase();
    db = dbModule.db;
    virtualKeysTable = dbModule.virtualKeysTable;
    tokenRecords = dbModule.tokenRecords;
    const proxyDepsModule = await import("./proxy-deps");
    createProxyDeps = proxyDepsModule.createProxyDeps;
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("aggregates rpm/tpm/daily/monthly by virtual key with correct token totals", async () => {
    const now = new Date("2026-08-06T12:00:00Z");

    const vk = (
      await db
        .insert(virtualKeysTable)
        .values({
          name: "quota-test-vk",
          apiKeyEncrypted: "x",
          enabled: 1,
          enabledModels: '["*"]',
        })
        .returning()
    )[0];

    // 同月不同日：8/5 23:59（日外、月内）、8/6 11:00（日内、月内）、8/6 11:59:30（60s 窗外）、8/6 11:59:40（60s 窗内）
    const records = [
      { vk: vk.id, at: "2026-08-05T23:59:00.000Z", i: 100, o: 50, cr: 10, cw: 5 },
      { vk: vk.id, at: "2026-08-06T11:00:00.000Z", i: 200, o: 100, cr: 20, cw: 10 },
      { vk: vk.id, at: "2026-08-06T11:59:30.000Z", i: 300, o: 150, cr: 30, cw: 15 },
      { vk: vk.id, at: "2026-08-06T11:59:40.000Z", i: 400, o: 200, cr: 40, cw: 20 },
    ];
    for (const r of records) {
      await db.insert(tokenRecords).values({
        model: "gpt-4o",
        provider: "p",
        agent: "a",
        inputTokens: r.i,
        outputTokens: r.o,
        cacheRead: r.cr,
        cacheWrite: r.cw,
        virtualKeyId: r.vk,
        createdAt: r.at,
      });
    }

    const deps = createProxyDeps();
    const usage = await deps.quota.loadUsage(vk.id, now);

    const tokens = (r: (typeof records)[number]) => r.i + r.o + r.cr + r.cw;
    const window = [records[2], records[3]].reduce((acc, r) => acc + tokens(r), 0);
    const daily = records.slice(1).reduce((acc, r) => acc + tokens(r), 0);
    const monthly = records.reduce((acc, r) => acc + tokens(r), 0);

    expect(usage.rpm).toBe(2);
    expect(usage.tpm).toBe(window);
    expect(usage.dailyTokens).toBe(daily);
    expect(usage.monthlyTokens).toBe(monthly);
  });
});
