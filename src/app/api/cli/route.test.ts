import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET as cliGET, resetCliSnapshot } from "./route";
import { GET as dashboardGET } from "@/app/api/dashboard/route";
import { closeDb, db, initDatabase, tokenRecords } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { localDateKeyFromUtcDate } from "@/lib/timezone-utils";
import { getTokenEpoch, setAdminApiKey } from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";

const ADMIN_KEY = "test-admin-key-123456";
// 固定在 UTC 06:00：任何 tzOffset（±12h）下本地时间都远离 00:00 日界，避开跨日界 flaky
const NOW = new Date("2026-03-15T06:00:00Z");

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-cli-route-"));
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
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  resetCliSnapshot();
  await initDatabase();
  await withSkipCache(async () => {
    await db.delete(tokenRecords);
  });
  await setAdminApiKey(ADMIN_KEY);
});

afterEach(() => {
  vi.useRealTimers();
});

function req(url = "/api/cli"): NextRequest {
  return new NextRequest(`http://localhost${url}`, { method: "GET" });
}

// getTimezoneOffset 语义：本地 = UTC - offset，故 UTC = 本地 + offset
function localDayStartUtcMs(tzOffsetMinutes: number): number {
  const localNowMs = Date.now() - tzOffsetMinutes * 60_000;
  const dayStartLocalMs = Math.floor(localNowMs / 86_400_000) * 86_400_000;
  return dayStartLocalMs + tzOffsetMinutes * 60_000;
}

async function insertRecord(
  overrides: Partial<typeof tokenRecords.$inferInsert> = {}
) {
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

describe("/api/cli 公开快照", () => {
  it("无需认证直接 200", async () => {
    const res = await cliGET(req());
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = await res.json();
    expect(typeof json.generatedAt).toBe("string");
    expect(json.summary).toBeTypeOf("object");
    expect(json.today).toBeTypeOf("object");
  });

  it("无数据时返回全 0 而非报错", async () => {
    const json = await (await cliGET(req())).json();
    expect(json.summary).toEqual({
      totalInput: 0,
      totalInputCached: 0,
      totalInputUncached: 0,
      totalCacheWrite: 0,
      totalOutput: 0,
      requests: 0,
      cacheHitRate: 0,
    });
    expect(json.today.date).toBe(localDateKeyFromUtcDate(new Date(), 0));
    expect(json.today.requests).toBe(0);
    expect(json.today.cacheHitRate).toBe(0);
  });

  it("summary 口径：totalInput 含 cache_read，uncached 不含", async () => {
    await insertRecord({ inputTokens: 800, cacheRead: 200, outputTokens: 500 });
    await insertRecord({ inputTokens: 100, cacheRead: 0, outputTokens: 50 });

    const json = await (await cliGET(req())).json();
    expect(json.summary.totalInput).toBe(1100);
    expect(json.summary.totalInputCached).toBe(200);
    expect(json.summary.totalInputUncached).toBe(900);
    expect(json.summary.totalOutput).toBe(550);
    expect(json.summary.requests).toBe(2);
    expect(json.summary.cacheHitRate).toBe(0.1818);
  });

  it("summary 与 today 字段集一致（均含 cache 字段，均不含 cost）", async () => {
    await insertRecord({ inputTokens: 300, cacheRead: 100, cacheWrite: 20 });

    const json = await (await cliGET(req())).json();
    const summaryKeys = Object.keys(json.summary).sort();
    const todayKeys = Object.keys(json.today).filter((k) => k !== "date").sort();
    expect(todayKeys).toEqual(summaryKeys);
    expect(summaryKeys).toEqual([
      "cacheHitRate",
      "requests",
      "totalCacheWrite",
      "totalInput",
      "totalInputCached",
      "totalInputUncached",
      "totalOutput",
    ]);
    expect(json.today.cacheHitRate).toBe(0.25);
    expect(json.summary).not.toHaveProperty("estimatedCost");
    expect(json.summary).not.toHaveProperty("avgCostPerMillion");
  });

  it("today 的日期随时区换算（与 /api/dashboard 同语义）", async () => {
    for (const tzOffset of [0, -480, -720, 720]) {
      resetCliSnapshot();
      const json = await (await cliGET(req(`/api/cli?tzOffset=${tzOffset}`))).json();
      expect(json.today.date).toBe(localDateKeyFromUtcDate(new Date(), tzOffset));
    }
  });

  it("today 按 tzOffset 日界归属：今天 00:10 与 23:50 都算今天", async () => {
    const tzOffset = -480;
    const dayStart = localDayStartUtcMs(tzOffset);
    await insertRecord({
      inputTokens: 100,
      createdAt: new Date(dayStart + 10 * 60_000).toISOString(),
    });
    await insertRecord({
      inputTokens: 200,
      createdAt: new Date(dayStart + 23 * 3_600_000 + 50 * 60_000).toISOString(),
    });

    const json = await (await cliGET(req(`/api/cli?tzOffset=${tzOffset}`))).json();
    expect(json.today.date).toBe(localDateKeyFromUtcDate(new Date(), tzOffset));
    expect(json.today.requests).toBe(2);
    expect(json.today.totalInput).toBe(300);
  });

  it("today 排除本地昨天 23:50 的记录", async () => {
    const tzOffset = -480;
    const beforeToday = localDayStartUtcMs(tzOffset) - 10 * 60_000;
    await insertRecord({
      inputTokens: 500,
      createdAt: new Date(beforeToday).toISOString(),
    });

    const json = await (await cliGET(req(`/api/cli?tzOffset=${tzOffset}`))).json();
    expect(json.today.requests).toBe(0);
    expect(json.today.totalInput).toBe(0);
    expect(json.summary.requests).toBe(1);
  });

  it("非法 tzOffset 返回 400（含 parseInt 会静默截断的形态）", async () => {
    for (const raw of ["999", "-721", "abc", "1abc", "1.5", "0x10", "", "+480"]) {
      resetCliSnapshot();
      const res = await cliGET(req(`/api/cli?tzOffset=${raw}`));
      expect(res.status).toBe(400);
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      const json = await res.json();
      expect(json.success).toBe(false);
      if (raw) expect(json.error).not.toContain(raw);
    }
  });

  it("忽略 provider/agent 过滤参数", async () => {
    await insertRecord({ provider: "openai", inputTokens: 100 });

    const res = await cliGET(
      req("/api/cli?provider=secret-provider&agent=claude-code&range=30d")
    );
    const text = await res.text();
    expect(res.status).toBe(200);
    // 未知 provider 不再 400，也不回显输入
    expect(text).not.toContain("secret-provider");
    expect(JSON.parse(text).summary.totalInput).toBe(100);
  });

  it("TTL 内复用快照不读库，reset 后重新读取", async () => {
    await insertRecord({ inputTokens: 100 });
    expect((await (await cliGET(req())).json()).summary.requests).toBe(1);

    await insertRecord({ inputTokens: 100 });
    expect((await (await cliGET(req())).json()).summary.requests).toBe(1);

    resetCliSnapshot();
    expect((await (await cliGET(req())).json()).summary.requests).toBe(2);
  });

  it("每 60s 全局刷新预算：第 9 个无缓存时区返回 429", async () => {
    for (let tz = 0; tz < 8; tz++) {
      expect((await cliGET(req(`/api/cli?tzOffset=${tz}`))).status).toBe(200);
    }

    const limited = await cliGET(req("/api/cli?tzOffset=8"));
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(limited.headers.get("Cache-Control")).toBe("no-store");
    expect((await limited.json()).success).toBe(false);

    // 已有新鲜快照的时区不受预算影响
    expect((await cliGET(req("/api/cli?tzOffset=0"))).status).toBe(200);
  });

  it("预算耗尽但有 stale 快照时返回旧数据而非 429", async () => {
    await insertRecord({ inputTokens: 100 });
    const first = await (await cliGET(req("/api/cli?tzOffset=0"))).json();
    expect(first.summary.requests).toBe(1);

    // 推进到下一个预算窗口（tz=0 的快照已过期），再把该窗口预算耗尽
    vi.setSystemTime(new Date(NOW.getTime() + 61_000));
    for (let tz = 1; tz <= 8; tz++) {
      expect((await cliGET(req(`/api/cli?tzOffset=${tz}`))).status).toBe(200);
    }

    await insertRecord({ inputTokens: 100 });
    const stale = await cliGET(req("/api/cli?tzOffset=0"));
    expect(stale.status).toBe(200);
    // 回退的是旧快照（不含新插入的记录），而不是刷新或 429
    expect((await stale.json()).summary.requests).toBe(1);
  });

  it("快照按时区隔离：不同 tzOffset 各自独立刷新", async () => {
    await insertRecord({
      inputTokens: 100,
      createdAt: new Date(localDayStartUtcMs(-480) + 60_000).toISOString(),
    });

    const first = await (await cliGET(req("/api/cli?tzOffset=-480"))).json();
    const second = await (await cliGET(req("/api/cli?tzOffset=480"))).json();
    expect(first.today.date).toBe(localDateKeyFromUtcDate(new Date(), -480));
    expect(second.today.date).toBe(localDateKeyFromUtcDate(new Date(), 480));
  });

  it("today 的数值与 /api/dashboard 相等", async () => {
    const tzOffset = -480;
    const dayStart = localDayStartUtcMs(tzOffset);
    await insertRecord({
      inputTokens: 300,
      cacheRead: 100,
      cacheWrite: 20,
      outputTokens: 80,
      createdAt: new Date(dayStart + 3_600_000).toISOString(),
    });
    await insertRecord({
      inputTokens: 50,
      createdAt: new Date(dayStart + 7_200_000).toISOString(),
    });

    const token = signSessionToken(
      await getTokenEpoch(),
      keyFingerprint(ADMIN_KEY),
      60_000
    );
    const dash = await (
      await dashboardGET(
        new NextRequest(`http://localhost/api/dashboard?tzOffset=${tzOffset}`, {
          headers: { "x-api-key": token },
        })
      )
    ).json();
    const cli = await (await cliGET(req(`/api/cli?tzOffset=${tzOffset}`))).json();

    expect(cli.today.date).toBe(dash.data.today.group);
    expect(cli.today.totalInput).toBe(dash.data.today.totalInput);
    expect(cli.today.totalInputCached).toBe(dash.data.today.totalInputCached);
    expect(cli.today.totalInputUncached).toBe(dash.data.today.totalInputUncached);
    expect(cli.today.totalCacheWrite).toBe(dash.data.today.totalCacheWrite);
    expect(cli.today.totalOutput).toBe(dash.data.today.totalOutput);
    expect(cli.today.requests).toBe(dash.data.today.count);
  });
});
