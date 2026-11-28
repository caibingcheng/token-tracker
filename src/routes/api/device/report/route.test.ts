// /api/device/report 集成测试：幂等、planId/deviceId 不匹配 404、usage 写 device_id、
// 分 mode 的健康标记（router 404 → model 标记；responses-create 404 → 零标记）
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { and, desc, eq } from "drizzle-orm";
import { POST } from "./route";
import {
  closeDb,
  db,
  deviceLatencyBucketsTable,
  devicePlansTable,
  devicesTable,
  initDatabase,
  tokenRecords,
  upstreamModelHealthTable,
  upstreamsTable,
  virtualKeysTable,
} from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { deviceTokenHash, generateDeviceToken } from "@/lib/device/pairing";
import { listDevices } from "@/lib/device/store";
import { healthTracker } from "@/lib/gateway/proxy-deps";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
let dir: string;

interface Seeded {
  token: string;
  deviceId: number;
  otherDeviceId: number;
  vkId: number;
  upstreamId: number;
  keyId: number;
}

async function seed(): Promise<Seeded> {
  const token = generateDeviceToken();
  const otherToken = generateDeviceToken();
  return withSkipCache(async () => {
    const device = await db
      .insert(devicesTable)
      .values({
        fingerprint: `u-${"d".repeat(32)}`,
        name: "laptop",
        publicKey: "pub",
        tokenHash: deviceTokenHash(token),
        createdAt: new Date().toISOString(),
      })
      .returning({ id: devicesTable.id });
    const other = await db
      .insert(devicesTable)
      .values({
        fingerprint: `u-${"e".repeat(32)}`,
        name: "desktop",
        publicKey: "pub2",
        tokenHash: deviceTokenHash(otherToken),
        createdAt: new Date().toISOString(),
      })
      .returning({ id: devicesTable.id });
    const vk = await db
      .insert(virtualKeysTable)
      .values({
        name: "vk-main",
        apiKeyEncrypted: "x",
        createdAt: new Date().toISOString(),
      })
      .returning({ id: virtualKeysTable.id });
    const upstream = await db
      .insert(upstreamsTable)
      .values({
        name: "u1",
        protocol: "openai",
        baseUrl: "https://u1.example.com/v1",
        enabledModels: '["gpt-a"]',
        priority: 1,
        enabled: 1,
      })
      .returning({ id: upstreamsTable.id });
    return {
      token,
      deviceId: Number(device[0]!.id),
      otherDeviceId: Number(other[0]!.id),
      vkId: Number(vk[0]!.id),
      upstreamId: Number(upstream[0]!.id),
      keyId: 101,
    };
  });
}

async function seedPlan(
  seeded: Seeded,
  over: {
    planId?: string;
    deviceId?: number;
    mode?: string;
    realModel?: string | null;
  } = {}
) {
  const planId = over.planId ?? `plan-${Math.random().toString(36).slice(2)}`;
  const now = Date.now();
  await withSkipCache(async () => {
    await db.insert(devicePlansTable).values({
      planId,
      deviceId: over.deviceId ?? seeded.deviceId,
      virtualKeyId: seeded.vkId,
      hopsJson: JSON.stringify([
        {
          hopIndex: 0,
          upstreamId: seeded.upstreamId,
          keyId: seeded.keyId,
          realModel: over.realModel === undefined ? "gpt-a" : over.realModel,
        },
      ]),
      mode: over.mode ?? "router",
      protocol: "openai",
      requestModel: "gpt-a",
      userAgent: "agent/1.0",
      sessionId: "route-session",
      recordSessionId: "record-session",
      reservedTokens: 100,
      reservedRpm: 1,
      createdAt: new Date().toISOString(),
      expiresAt: now + 600_000,
    });
  });
  return planId;
}

function reportRequest(token: string, body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/device/report", {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const usage = { inputTokens: 11, outputTokens: 7, cacheRead: 3, cacheWrite: 0, hasUsage: true };
const winner = (seeded: Seeded) => ({
  hopIndex: 0,
  upstreamId: seeded.upstreamId,
  keyId: seeded.keyId,
});

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-devicereport-"));
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
    await db.delete(devicePlansTable);
    await db.delete(deviceLatencyBucketsTable);
    await db.delete(tokenRecords);
    await db.delete(upstreamModelHealthTable);
    await db.delete(upstreamsTable);
    await db.delete(virtualKeysTable);
    await db.delete(devicesTable);
  });
});

describe("POST /api/device/report", () => {
  it("usage 写 token_records（device_id + plan 行的 session/request_model），并释放预留", async () => {
    const seeded = await seed();
    const planId = await seedPlan(seeded);
    const res = await POST(
      reportRequest(seeded.token, {
        planId,
        status: "ok",
        winner: winner(seeded),
        failures: [],
        usage,
        latencyMs: 1200,
        ttftMs: 300,
      })
    );
    expect(res.status).toBe(200);

    const rows = await withSkipCache(async () => db.select().from(tokenRecords));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      model: "gpt-a",
      provider: "u1",
      agent: "vk-main",
      inputTokens: 11,
      outputTokens: 7,
      cacheRead: 3,
      virtualKeyId: seeded.vkId,
      userAgent: "agent/1.0",
      sessionId: "record-session",
      requestModel: "gpt-a",
      deviceId: seeded.deviceId,
      latencyMs: 1200,
      ttftMs: 300,
      status: null,
    });

    const plan = await withSkipCache(async () => {
      const r = await db.select().from(devicePlansTable).where(eq(devicePlansTable.planId, planId));
      return r[0];
    });
    expect(plan?.reportedAt).toBeTruthy();
    expect(plan?.status).toBe("ok");
  });

  it("幂等：同一 plan 重复 report 只生效一次", async () => {
    const seeded = await seed();
    const planId = await seedPlan(seeded);
    const body = { planId, status: "ok", winner: winner(seeded), failures: [], usage };
    expect((await POST(reportRequest(seeded.token, body))).status).toBe(200);
    const second = await POST(reportRequest(seeded.token, body));
    expect(second.status).toBe(200);
    expect(((await second.json()) as any).duplicate).toBe(true);
    const rows = await withSkipCache(async () => db.select().from(tokenRecords));
    expect(rows).toHaveLength(1);
  });

  it("planId 不存在 / 属于其他 device → 404", async () => {
    const seeded = await seed();
    expect(
      (await POST(reportRequest(seeded.token, { planId: "nope", status: "ok", usage }))).status
    ).toBe(404);

    const foreignPlan = await seedPlan(seeded, { deviceId: seeded.otherDeviceId });
    expect(
      (
        await POST(
          reportRequest(seeded.token, { planId: foreignPlan, status: "ok", usage })
        )
      ).status
    ).toBe(404);
  });

  it("client_aborted / stream_interrupted：只写状态行，不写 usage", async () => {
    const seeded = await seed();
    for (const status of ["client_aborted", "stream_interrupted"]) {
      const planId = await seedPlan(seeded);
      const res = await POST(
        reportRequest(seeded.token, { planId, status, winner: null, failures: [], usage })
      );
      expect(res.status).toBe(200);
    }
    const rows = await withSkipCache(async () => db.select().from(tokenRecords));
    expect(rows).toHaveLength(0);
  });

  it("client_aborted / stream_interrupted 带 winner → 仍写一条记录（status 用中断态，与直连同口径）", async () => {
    const seeded = await seed();
    for (const status of ["client_aborted", "stream_interrupted"]) {
      const planId = await seedPlan(seeded);
      const res = await POST(
        reportRequest(seeded.token, {
          planId,
          status,
          winner: winner(seeded),
          failures: [],
          usage: { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, hasUsage: false },
        })
      );
      expect(res.status).toBe(200);
    }
    const rows = await withSkipCache(async () => db.select().from(tokenRecords));
    expect(rows.map((r) => r.status).sort()).toEqual(["client_aborted", "stream_interrupted"]);
    // 中断行不估算：零 token
    expect(rows.every((r) => r.inputTokens === 0 && r.outputTokens === 0)).toBe(true);
  });

  it("client_aborted 但无 winner（不知落点）→ 不写行", async () => {
    const seeded = await seed();
    const planId = await seedPlan(seeded);
    const res = await POST(
      reportRequest(seeded.token, { planId, status: "client_aborted", winner: null, failures: [], usage })
    );
    expect(res.status).toBe(200);
    const rows = await withSkipCache(async () => db.select().from(tokenRecords));
    expect(rows).toHaveLength(0);
  });

  it("estimated 标志 → 写 status='estimated'；无标志 → no_usage", async () => {
    const seeded = await seed();
    const zero = { inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, hasUsage: false };
    for (const [estimated, expected] of [
      [true, "estimated"],
      [false, "no_usage"],
    ] as const) {
      await POST(
        reportRequest(seeded.token, {
          planId: await seedPlan(seeded),
          status: "ok",
          winner: winner(seeded),
          failures: [],
          usage: { ...zero, estimated },
        })
      );
      const [row] = await withSkipCache(async () =>
        db.select().from(tokenRecords).orderBy(desc(tokenRecords.id)).limit(1)
      );
      expect(row?.status).toBe(expected);
    }
  });

  it("router：404 → model 级健康标记", async () => {
    const seeded = await seed();
    const planId = await seedPlan(seeded);
    await POST(
      reportRequest(seeded.token, {
        planId,
        status: "failed",
        winner: null,
        failures: [
          { hopIndex: 0, upstreamId: seeded.upstreamId, keyId: seeded.keyId, status: 404, bodyKind: "json", cause: "http" },
        ],
        usage: null,
      })
    );
    await expect(
      healthTracker.isModelHealthy(seeded.upstreamId, "gpt-a")
    ).resolves.toBe(false);
  });

  it("responses-create：404 不打 model 级标记（suppressHealth）", async () => {
    const seeded = await seed();
    const planId = await seedPlan(seeded, { mode: "responses-create" });
    await POST(
      reportRequest(seeded.token, {
        planId,
        status: "failed",
        winner: null,
        failures: [
          { hopIndex: 0, upstreamId: seeded.upstreamId, keyId: seeded.keyId, status: 404, bodyKind: "json", cause: "http" },
        ],
        usage: null,
      })
    );
    await expect(
      healthTracker.isModelHealthy(seeded.upstreamId, "gpt-a")
    ).resolves.toBe(true);
    const rows = await withSkipCache(async () =>
      db
        .select()
        .from(upstreamModelHealthTable)
        .where(and(eq(upstreamModelHealthTable.upstreamId, seeded.upstreamId)))
    );
    expect(rows).toEqual([]);
  });

  it("centerRtt 桶落库（覆盖写：重传不翻倍），列表返回 latency 概览", async () => {
    const seeded = await seed();
    const planId = await seedPlan(seeded);
    const start = Math.floor(Date.now() / 60_000) * 60_000;
    const body = {
      planId,
      status: "ok",
      winner: winner(seeded),
      failures: [],
      usage,
      latencyMs: 1200,
      ttftMs: 300,
      centerRtt: [{ kind: "plan", start, count: 2, sumMs: 400, maxMs: 300, lastMs: 100 }],
    };
    expect((await POST(reportRequest(seeded.token, body))).status).toBe(200);
    // 第二次进 duplicate 分支，但桶是覆盖写：count 不会翻倍
    expect((await POST(reportRequest(seeded.token, body))).status).toBe(200);

    const rows = await withSkipCache(async () => db.select().from(deviceLatencyBucketsTable));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      deviceId: seeded.deviceId,
      kind: "plan",
      bucketStart: start,
      count: 2,
      sumMs: 400,
      maxMs: 300,
      lastMs: 100,
    });

    const list = await listDevices();
    const latency = list.find((d) => d.id === seeded.deviceId)?.latency;
    expect(latency?.plan.samples).toBe(2);
    expect(latency?.plan.latestMs).toBe(100);
    expect(latency?.plan.avgMs).toBe(200);
    expect(latency?.report.samples).toBe(0);
  });
});
