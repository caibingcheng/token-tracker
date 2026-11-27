// relay RTT 桶：解析自校验、覆盖写幂等、5h 聚合口径
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  closeDb,
  db,
  deviceLatencyBucketsTable,
  initDatabase,
} from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import {
  latencySummaries,
  parseRttBuckets,
  recordRttBuckets,
  RTT_TICK_MS,
  RTT_WINDOW_MS,
} from "./latency";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
let dir: string;

const NOW = 1_700_000_000_000;
const CURRENT = Math.floor(NOW / RTT_TICK_MS) * RTT_TICK_MS;

const bucket = (over: Record<string, unknown> = {}) => ({
  kind: "plan",
  start: CURRENT,
  count: 2,
  sumMs: 300,
  maxMs: 200,
  lastMs: 100,
  ...over,
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-latency-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
  await initDatabase();
  await withSkipCache(async () => {
    await db.delete(deviceLatencyBucketsTable);
  });
});

describe("parseRttBuckets", () => {
  it("合法桶通过", () => {
    expect(parseRttBuckets([bucket()], NOW)).toEqual([
      { kind: "plan", start: CURRENT, count: 2, sumMs: 300, maxMs: 200, lastMs: 100 },
    ]);
  });

  it("未知 kind / 非分钟对齐 / 窗口外 / 超窗口未来 → 丢弃", () => {
    const raw = [
      bucket({ kind: "other" }),
      bucket({ start: CURRENT + 1000 }),
      bucket({ start: CURRENT - RTT_WINDOW_MS - RTT_TICK_MS }),
      bucket({ start: CURRENT + 2 * RTT_TICK_MS }),
    ];
    expect(parseRttBuckets(raw, NOW)).toEqual([]);
  });

  it("容忍 relay 时钟快一个桶", () => {
    expect(parseRttBuckets([bucket({ start: CURRENT + RTT_TICK_MS })], NOW)).toHaveLength(1);
  });

  it("count / sum / max 不自洽 → 丢弃", () => {
    const raw = [
      bucket({ count: 0 }),
      bucket({ count: 100_001 }),
      bucket({ maxMs: 60_001 }),
      bucket({ lastMs: 60_001 }),
      bucket({ sumMs: 2 * 60_000 + 1 }),
    ];
    expect(parseRttBuckets(raw, NOW)).toEqual([]);
  });

  it("同一桶重复出现只保留第一份，且最多接受 8 项", () => {
    expect(parseRttBuckets([bucket(), bucket({ count: 9 })], NOW)).toHaveLength(1);
    const many = Array.from({ length: 12 }, (_, i) =>
      bucket({ start: CURRENT - i * RTT_TICK_MS })
    );
    expect(parseRttBuckets(many, NOW)).toHaveLength(8);
  });

  it("非数组 / undefined → 空", () => {
    expect(parseRttBuckets(undefined, NOW)).toEqual([]);
    expect(parseRttBuckets({}, NOW)).toEqual([]);
  });
});

describe("recordRttBuckets + latencySummaries", () => {
  it("覆盖写幂等：同一桶重传不会重复累加", async () => {
    const buckets = parseRttBuckets([bucket()], NOW);
    await recordRttBuckets(1, buckets);
    await recordRttBuckets(1, buckets);
    const rows = await withSkipCache(async () => db.select().from(deviceLatencyBucketsTable));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ deviceId: 1, kind: "plan", count: 2, sumMs: 300 });
  });

  it("聚合：latest = 最近桶的 lastMs，avg = Σsum/Σcount，max = 最大 maxMs", async () => {
    const older = CURRENT - RTT_TICK_MS;
    await recordRttBuckets(7, parseRttBuckets([bucket({ start: older })], NOW));
    await recordRttBuckets(
      7,
      parseRttBuckets([bucket({ count: 1, sumMs: 900, maxMs: 900, lastMs: 900 })], NOW)
    );

    const summaries = await latencySummaries(NOW);
    const plan = summaries.get(7)?.plan;
    expect(plan).toEqual({
      samples: 3,
      avgMs: Math.round((300 + 900) / 3),
      maxMs: 900,
      latestMs: 900,
    });
    // 没有 report 样本 → 全 null
    expect(summaries.get(7)?.report).toEqual({ samples: 0, latestMs: null, avgMs: null, maxMs: null });
  });

  it("空数组不写行", async () => {
    await recordRttBuckets(1, []);
    const rows = await withSkipCache(async () => db.select().from(deviceLatencyBucketsTable));
    expect(rows).toHaveLength(0);
  });
});
