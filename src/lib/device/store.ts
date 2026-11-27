// relay 设备 / 配对 / 计划的 DB 访问层（仅中心使用）。
// 全部写操作走 withSkipCache：device 列表、revoke 生效、配额都不允许 10s 缓存残留。
import { and, desc, eq, isNull, lt, sql } from "drizzle-orm";
import {
  db,
  initDatabase,
  devicesTable,
  devicePairingsTable,
  devicePlansTable,
  tokenRecords,
} from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import {
  PAIRING_MAX_PENDING_PER_IP,
  PAIRING_MAX_POLLS,
  PAIRING_MAX_SECRET_FAILURES,
  PAIRING_POLL_INTERVAL_S,
  PAIRING_SLOW_DOWN_MAX_INTERVAL_S,
  PAIRING_TTL_MS,
  deviceTokenHash,
  generateDeviceToken,
  generatePairingCode,
  normalizePairingCode,
  pairingCodeHash,
  sanitizeDeviceName,
  sha256Hex,
} from "./pairing";
import { emptyDeviceLatency, latencySummaries, sweepRttBuckets, type DeviceLatency } from "./latency";

export class PairingLimitError extends Error {
  constructor() {
    super("Too many pending pairing sessions");
    this.name = "PairingLimitError";
  }
}

export interface DeviceListItem {
  id: number;
  fingerprint: string;
  name: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  status: "pending" | "active" | "revoked";
  recordCount30d: number;
  /** relay ⇄ 中心 RTT 的 5h 概览（无样本 = 全 null） */
  latency: DeviceLatency;
}

export interface PairingLookup {
  name: string | null;
  fingerprint: string;
  clientIp: string | null;
  createdAt: string;
  expiresAt: number;
}

/** 待授权配对（/admin/devices 的列表）：pairingId = code_hash，
 * 会话态可见、不足以反推 8 位码，用于列表里一键授权/拒绝（免手输码）。 */
export interface PendingPairing extends PairingLookup {
  pairingId: string;
}

export type PollResult =
  | { state: "pending" }
  | { state: "slow_down"; interval: number }
  | { state: "authorized"; token: string; deviceId: number; name: string | null; fingerprint: string }
  | { state: "denied" }
  | { state: "expired" }
  // 未知码 / clientSecret 不匹配一律走这里（不区分，防枚举）
  | { state: "unknown" };

// 轮询节奏的宽容量：relay 按 5s 定时器轮询时可能落在 4999ms，不应因此判 slow_down
const POLL_GRACE_MS = 250;

// slow_down 只在进程内跟踪（配对是秒级瞬态，不值得为它加列）
const pollState = new Map<
  string,
  { interval: number; lastPollAt: number; secretFailures: number }
>();

// 未上报就过期的计划行数（预留泄漏）：清扫时累计 + 实时可查
let relayGapCount = 0;

export function getRelayGapCount(): number {
  return relayGapCount;
}

function nowMs(): number {
  return Date.now();
}

// ---- 配对 ----

export async function startPairing(input: {
  fingerprint: string;
  name: string | null;
  publicKey: string;
  clientSecret: string;
  clientIp: string | null;
  userAgent: string | null;
}): Promise<{ code: string; expiresIn: number; interval: number }> {
  await initDatabase();
  return withSkipCache(async () => {
    const now = nowMs();
    await sweepPairings(now);
    if (input.clientIp) {
      const pending = await db
        .select({ n: sql<number>`count(*)` })
        .from(devicePairingsTable)
        .where(
          and(
            eq(devicePairingsTable.clientIp, input.clientIp),
            eq(devicePairingsTable.status, "pending"),
            sql`${devicePairingsTable.expiresAt} > ${now}`
          )
        );
      if (Number(pending[0]?.n ?? 0) >= PAIRING_MAX_PENDING_PER_IP) {
        throw new PairingLimitError();
      }
    }

    // 码碰撞概率可忽略（32^8），但仍按主键冲突重试
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generatePairingCode();
      const codeHash = pairingCodeHash(normalizePairingCode(code)!);
      try {
        await db.insert(devicePairingsTable).values({
          codeHash,
          clientSecretHash: sha256Hex(input.clientSecret),
          fingerprint: input.fingerprint,
          name: input.name,
          publicKey: input.publicKey,
          clientIp: input.clientIp,
          userAgent: input.userAgent,
          status: "pending",
          pollCount: 0,
          createdAt: new Date(now).toISOString(),
          expiresAt: now + PAIRING_TTL_MS,
        });
        return { code, expiresIn: Math.floor(PAIRING_TTL_MS / 1000), interval: PAIRING_POLL_INTERVAL_S };
      } catch {
        // 主键冲突：换一个码重试
      }
    }
    throw new Error("failed to allocate a pairing code");
  });
}

export async function pollPairing(input: {
  code: string;
  clientSecret: string;
  clientIp: string | null;
  userAgent: string | null;
}): Promise<PollResult> {
  await initDatabase();
  return withSkipCache(async () => {
    const normalized = normalizePairingCode(input.code);
    if (!normalized) return { state: "unknown" };
    const codeHash = pairingCodeHash(normalized);
    const rows = await db
      .select()
      .from(devicePairingsTable)
      .where(eq(devicePairingsTable.codeHash, codeHash));
    const row = rows[0];
    if (!row) return { state: "unknown" };

    const now = nowMs();
    const secretOk = row.clientSecretHash === sha256Hex(input.clientSecret);
    const state = pollState.get(codeHash) ?? {
      interval: PAIRING_POLL_INTERVAL_S,
      lastPollAt: 0,
      secretFailures: 0,
    };
    if (!secretOk) {
      // 错 secret 累计 3 次立即作废；对外始终 428（不产生 oracle）
      state.secretFailures += 1;
      pollState.set(codeHash, state);
      if (state.secretFailures >= PAIRING_MAX_SECRET_FAILURES) {
        await db
          .update(devicePairingsTable)
          .set({ status: "expired" })
          .where(eq(devicePairingsTable.codeHash, codeHash));
      }
      return { state: "unknown" };
    }

    if (row.status === "denied") return { state: "denied" };
    if (row.status === "expired") return { state: "expired" };
    if (row.expiresAt <= now) {
      await db
        .update(devicePairingsTable)
        .set({ status: "expired" })
        .where(eq(devicePairingsTable.codeHash, codeHash));
      return { state: "expired" };
    }

    if (now - state.lastPollAt < state.interval * 1000 - POLL_GRACE_MS) {
      state.interval = Math.min(
        PAIRING_SLOW_DOWN_MAX_INTERVAL_S,
        Math.max(PAIRING_POLL_INTERVAL_S, state.interval * 2)
      );
      pollState.set(codeHash, state);
      return { state: "slow_down", interval: state.interval };
    }
    state.lastPollAt = now;
    pollState.set(codeHash, state);

    const count = Number(row.pollCount ?? 0) + 1;
    if (count > PAIRING_MAX_POLLS) {
      await db
        .update(devicePairingsTable)
        .set({ pollCount: count, status: "expired" })
        .where(eq(devicePairingsTable.codeHash, codeHash));
      return { state: "expired" };
    }
    await db
      .update(devicePairingsTable)
      .set({ pollCount: count })
      .where(eq(devicePairingsTable.codeHash, codeHash));

    if (row.status !== "authorized") return { state: "pending" };
    if (row.consumedAt) return { state: "expired" };

    const devices = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.fingerprint, row.fingerprint));
    const device = devices[0];
    if (!device) return { state: "expired" };

    const token = generateDeviceToken();
    await db
      .update(devicesTable)
      .set({ tokenHash: deviceTokenHash(token) })
      .where(eq(devicesTable.id, device.id));
    await db
      .update(devicePairingsTable)
      .set({ consumedAt: new Date(now).toISOString() })
      .where(eq(devicePairingsTable.codeHash, codeHash));
    pollState.delete(codeHash);
    return {
      state: "authorized",
      token,
      deviceId: device.id,
      name: device.name ?? row.name ?? null,
      fingerprint: device.fingerprint,
    };
  });
}

// admin「输码 → 看设备 → 授权」中的查看步骤：不消费码，不改状态
export async function lookupPairing(code: string): Promise<PairingLookup | null> {
  await initDatabase();
  return withSkipCache(async () => {
    const normalized = normalizePairingCode(code);
    if (!normalized) return null;
    const rows = await db
      .select()
      .from(devicePairingsTable)
      .where(eq(devicePairingsTable.codeHash, pairingCodeHash(normalized)));
    const row = rows[0];
    if (!row) return null;
    return {
      name: row.name ?? null,
      fingerprint: row.fingerprint,
      clientIp: row.clientIp ?? null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    };
  });
}

// admin 授权：登记/复用 devices 行，配对会话置 authorized（token 由 poll 一次性取走）。
// 定位配对会话支持两种方式：`pairingId`（= code_hash，列表里一键授权）或 `code`（手输）。
async function findPairingRow(input: { code?: string; pairingId?: string }) {
  if (input.pairingId) {
    const rows = await db
      .select()
      .from(devicePairingsTable)
      .where(eq(devicePairingsTable.codeHash, input.pairingId));
    return rows[0] ?? null;
  }
  const normalized = normalizePairingCode(input.code ?? "");
  if (!normalized) return null;
  const rows = await db
    .select()
    .from(devicePairingsTable)
    .where(eq(devicePairingsTable.codeHash, pairingCodeHash(normalized)));
  return rows[0] ?? null;
}

export async function authorizePairing(input: {
  code?: string;
  pairingId?: string;
  name?: string | null;
}): Promise<
  | { ok: true; deviceId: number; fingerprint: string; name: string | null; reauth: boolean }
  | { ok: false; reason: "not_found" | "expired" | "not_pending" }
> {
  await initDatabase();
  return withSkipCache(async () => {
    const row = await findPairingRow(input);
    if (!row) return { ok: false as const, reason: "not_found" as const };
    const now = nowMs();
    if (row.expiresAt <= now || row.status === "expired") {
      return { ok: false as const, reason: "expired" as const };
    }
    if (row.status !== "pending") {
      return { ok: false as const, reason: "not_pending" as const };
    }

    const name = sanitizeDeviceName(input.name ?? row.name, "relay");
    const existing = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.fingerprint, row.fingerprint));
    let deviceId: number;
    const reauth = existing.length > 0;
    if (existing[0]) {
      deviceId = existing[0].id;
      await db
        .update(devicesTable)
        .set({ name, publicKey: row.publicKey, revokedAt: null })
        .where(eq(devicesTable.id, deviceId));
    } else {
      const inserted = await db
        .insert(devicesTable)
        .values({
          fingerprint: row.fingerprint,
          name,
          publicKey: row.publicKey,
          createdAt: new Date(now).toISOString(),
        })
        .returning({ id: devicesTable.id });
      deviceId = Number(inserted[0]?.id ?? 0);
    }

    await db
      .update(devicePairingsTable)
      .set({ status: "authorized", name })
      .where(eq(devicePairingsTable.codeHash, row.codeHash));

    return { ok: true as const, deviceId, fingerprint: row.fingerprint, name, reauth };
  });
}

export async function denyPairing(input: { code?: string; pairingId?: string }): Promise<boolean> {
  await initDatabase();
  return withSkipCache(async () => {
    const row = await findPairingRow(input);
    if (!row || row.status !== "pending") return false;
    await db
      .update(devicePairingsTable)
      .set({ status: "denied" })
      .where(eq(devicePairingsTable.codeHash, row.codeHash));
    pollState.delete(row.codeHash);
    return true;
  });
}

export async function listPendingPairings(): Promise<PendingPairing[]> {
  await initDatabase();
  return withSkipCache(async () => {
    const now = nowMs();
    const rows = await db
      .select()
      .from(devicePairingsTable)
      .where(
        and(
          eq(devicePairingsTable.status, "pending"),
          sql`${devicePairingsTable.expiresAt} > ${now}`
        )
      )
      .orderBy(desc(devicePairingsTable.createdAt));
    return rows.map((row: any) => ({
      pairingId: row.codeHash,
      name: row.name ?? null,
      fingerprint: row.fingerprint,
      clientIp: row.clientIp ?? null,
      createdAt: row.createdAt,
      expiresAt: row.expiresAt,
    }));
  });
}

// ---- 设备 ----

export async function getDeviceByTokenHash(tokenHash: string) {
  await initDatabase();
  return withSkipCache(async () => {
    const rows = await db
      .select()
      .from(devicesTable)
      .where(eq(devicesTable.tokenHash, tokenHash));
    return rows[0] ?? null;
  });
}

export async function touchDeviceLastSeen(deviceId: number): Promise<void> {
  await initDatabase();
  await withSkipCache(async () => {
    await db
      .update(devicesTable)
      .set({ lastSeenAt: new Date().toISOString() })
      .where(eq(devicesTable.id, deviceId));
  });
}

export async function listDevices(): Promise<DeviceListItem[]> {
  await initDatabase();
  return withSkipCache(async () => {
    const rows = await db.select().from(devicesTable).orderBy(desc(devicesTable.id));
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const counts = await db
      .select({ deviceId: tokenRecords.deviceId, n: sql<number>`count(*)` })
      .from(tokenRecords)
      .where(and(sql`${tokenRecords.deviceId} IS NOT NULL`, sql`${tokenRecords.createdAt} >= ${cutoff}`))
      .groupBy(tokenRecords.deviceId);
    const countByDevice = new Map<number, number>(
      counts.map((c: any) => [Number(c.deviceId), Number(c.n)])
    );
    const latencyByDevice = await latencySummaries();
    return rows.map((row: any) => ({
      id: row.id,
      fingerprint: row.fingerprint,
      name: row.name ?? null,
      createdAt: row.createdAt,
      lastSeenAt: row.lastSeenAt ?? null,
      revokedAt: row.revokedAt ?? null,
      status: row.revokedAt
        ? ("revoked" as const)
        : row.tokenHash
          ? ("active" as const)
          : ("pending" as const),
      recordCount30d: countByDevice.get(row.id) ?? 0,
      latency: latencyByDevice.get(row.id) ?? emptyDeviceLatency(),
    }));
  });
}

export async function renameDevice(id: number, name: string): Promise<boolean> {
  await initDatabase();
  return withSkipCache(async () => {
    const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, id));
    if (!rows[0]) return false;
    await db.update(devicesTable).set({ name }).where(eq(devicesTable.id, id));
    return true;
  });
}

export async function setDeviceRevoked(id: number, revoked: boolean): Promise<boolean> {
  await initDatabase();
  return withSkipCache(async () => {
    const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, id));
    if (!rows[0]) return false;
    await db
      .update(devicesTable)
      .set({ revokedAt: revoked ? new Date().toISOString() : null })
      .where(eq(devicesTable.id, id));
    return true;
  });
}

export async function rotateDeviceToken(
  id: number
): Promise<{ token: string } | null> {
  await initDatabase();
  return withSkipCache(async () => {
    const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, id));
    if (!rows[0]) return null;
    const token = generateDeviceToken();
    await db
      .update(devicesTable)
      .set({ tokenHash: deviceTokenHash(token) })
      .where(eq(devicesTable.id, id));
    return { token };
  });
}

// 删除设备：清该 device 的 device_plans，token_records 保留但 device_id 置 NULL（不删历史统计）
export async function deleteDevice(
  id: number
): Promise<{ fingerprint: string; name: string | null; plansDeleted: number } | null> {
  await initDatabase();
  return withSkipCache(async () => {
    const rows = await db.select().from(devicesTable).where(eq(devicesTable.id, id));
    const row = rows[0];
    if (!row) return null;
    const plans = await db
      .delete(devicePlansTable)
      .where(eq(devicePlansTable.deviceId, id))
      .returning({ planId: devicePlansTable.planId });
    await db
      .update(tokenRecords)
      .set({ deviceId: null })
      .where(eq(tokenRecords.deviceId, id));
    await db.delete(devicesTable).where(eq(devicesTable.id, id));
    return {
      fingerprint: row.fingerprint,
      name: row.name ?? null,
      plansDeleted: plans.length,
    };
  });
}

export async function getDeviceStats(): Promise<{
  pendingPairings: number;
  relayGapCount: number;
  plansLastMinute: number;
  reportsLastMinute: number;
  devices: number;
  activeDevices: number;
}> {
  await initDatabase();
  return withSkipCache(async () => {
    const now = nowMs();
    const minuteAgo = new Date(now - 60_000).toISOString();
    const pending = await db
      .select({ n: sql<number>`count(*)` })
      .from(devicePairingsTable)
      .where(
        and(
          eq(devicePairingsTable.status, "pending"),
          sql`${devicePairingsTable.expiresAt} > ${now}`
        )
      );
    const plans = await db
      .select({ n: sql<number>`count(*)` })
      .from(devicePlansTable)
      .where(sql`${devicePlansTable.createdAt} >= ${minuteAgo}`);
    const reports = await db
      .select({ n: sql<number>`count(*)` })
      .from(devicePlansTable)
      .where(
        and(
          sql`${devicePlansTable.reportedAt} IS NOT NULL`,
          sql`${devicePlansTable.reportedAt} >= ${minuteAgo}`
        )
      );
    const expiredUnreported = await db
      .select({ n: sql<number>`count(*)` })
      .from(devicePlansTable)
      .where(
        and(isNull(devicePlansTable.reportedAt), lt(devicePlansTable.expiresAt, now))
      );
    const all = await db.select({ n: sql<number>`count(*)` }).from(devicesTable);
    const active = await db
      .select({ n: sql<number>`count(*)` })
      .from(devicesTable)
      .where(and(isNull(devicesTable.revokedAt), sql`${devicesTable.tokenHash} IS NOT NULL`));
    return {
      pendingPairings: Number(pending[0]?.n ?? 0),
      relayGapCount: relayGapCount + Number(expiredUnreported[0]?.n ?? 0),
      plansLastMinute: Number(plans[0]?.n ?? 0),
      reportsLastMinute: Number(reports[0]?.n ?? 0),
      devices: Number(all[0]?.n ?? 0),
      activeDevices: Number(active[0]?.n ?? 0),
    };
  });
}

// ---- 清扫（每 60s 一次，惰性触发；未启用 relay 时零开销） ----

const SWEEP_INTERVAL_MS = 60_000;
let lastSweepAt = 0;

export async function maybeSweep(now: number = Date.now()): Promise<void> {
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;
  await initDatabase();
  await withSkipCache(async () => {
    await sweepPairings(now);
    // 预留泄漏：未上报且已过期 → 删除并计数
    const leaked = await db
      .delete(devicePlansTable)
      .where(and(isNull(devicePlansTable.reportedAt), lt(devicePlansTable.expiresAt, now)))
      .returning({ planId: devicePlansTable.planId });
    relayGapCount += leaked.length;
    // 已完成的计划行 30 天后清理
    const cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
    await db
      .delete(devicePlansTable)
      .where(
        and(
          sql`${devicePlansTable.reportedAt} IS NOT NULL`,
          lt(devicePlansTable.createdAt, cutoff)
        )
      );
    // RTT 桶只保留 5h 窗口（多留一分钟给未闭合桶）
    await sweepRttBuckets(now);
  });
}

async function sweepPairings(now: number): Promise<void> {
  await db
    .delete(devicePairingsTable)
    .where(lt(devicePairingsTable.expiresAt, now - 24 * 60 * 60 * 1000));
}

// 仅供测试：复位清扫节奏与计数器
export function resetDeviceSweeperForTests(): void {
  lastSweepAt = 0;
  relayGapCount = 0;
  pollState.clear();
}
