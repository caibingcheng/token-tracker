// /api/device/report：请求结束后回报结果。
//
// 幂等：`UPDATE ... WHERE reported_at IS NULL`，changes === 0 直接 200 丢弃。
// 写库素材（model / session_id / request_model / user_agent / vk）全部取自 device_plans 行，
// report 只回 hopIndex —— sub node 是不可信的，不能让它决定写库口径。
import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { withDeviceAuth, type DeviceContext } from "@/lib/auth/device-guard";
import {
  readJsonBodyLimited,
  BodyTooLargeError,
  InvalidJsonBodyError,
} from "@/lib/auth/request-body";
import { createSlidingWindowLimiter } from "@/lib/device/rate-limit";
import { planHealthActions } from "@/lib/device/report";
import type { ReportFailure, ReportHop, ReportWinner } from "@/lib/device/report";
import { maybeSweep } from "@/lib/device/store";
import { db, devicePlansTable, initDatabase, tokenRecords, upstreamsTable, virtualKeysTable } from "@/lib/db";
import { invalidateQueryCache, withSkipCache } from "@/lib/db/cache";
import { createProxyDeps, saveResponseBinding } from "@/lib/gateway/proxy-deps";
import { parseRttBuckets, recordRttBuckets } from "@/lib/device/latency";

const REPORT_BODY_LIMIT = 8 * 1024;
const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 20 });
const VALID_STATUS = new Set(["ok", "failed", "client_aborted", "stream_interrupted"]);

function badRequest(message: string) {
  return NextResponse.json({ error: { message, type: "invalid_request_error" } }, { status: 400 });
}

function intOrNull(value: unknown): number | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.floor(n);
}

export const POST = withDeviceAuth(async (request: NextRequest, device: DeviceContext) => {
  void maybeSweep().catch(() => {});
  if (limiter.hit(String(device.id))) {
    return NextResponse.json({ error: { message: "Too many report requests", type: "rate_limited" } }, { status: 429 });
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyLimited(request, REPORT_BODY_LIMIT);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return badRequest("Request body too large");
    if (err instanceof InvalidJsonBodyError) return badRequest("Invalid JSON body");
    throw err;
  }

  const planId = typeof body.planId === "string" ? body.planId.slice(0, 64) : "";
  const status = typeof body.status === "string" ? body.status : "";
  if (!planId || !VALID_STATUS.has(status)) return badRequest("planId/status is required");

  await initDatabase();
  const plan = await withSkipCache(async () => {
    const rows = await db
      .select()
      .from(devicePlansTable)
      .where(eq(devicePlansTable.planId, planId));
    return rows[0] ?? null;
  });
  // planId 不存在或不属于该 device → 404（不 403，避免探测他人 planId）
  if (!plan || plan.deviceId !== device.id) {
    return NextResponse.json({ error: { message: "Plan not found", type: "not_found" } }, { status: 404 });
  }

  const nowIso = new Date().toISOString();
  // relay 自测的 RTT 分钟桶：覆盖写（已闭合桶内容不变）、重传幂等。放在 reported_at 幂等检查之前，
  // 这样 report 重试还能把丢掉的桶补上；写失败直接 500 让 relay 退避重试（不静默丢可观测性数据）。
  await recordRttBuckets(device.id, parseRttBuckets(body.centerRtt));

  const updated = await withSkipCache(async () =>
    db
      .update(devicePlansTable)
      .set({ reportedAt: nowIso, status })
      .where(and(eq(devicePlansTable.planId, planId), isNull(devicePlansTable.reportedAt)))
      .returning({ planId: devicePlansTable.planId })
  );
  if (updated.length === 0) {
    return NextResponse.json({ ok: true, duplicate: true });
  }

  const hops = parseHops(plan.hopsJson);
  const failures = parseFailures(body.failures).filter((f) =>
    hops.some((h) => h.hopIndex === f.hopIndex && h.upstreamId === f.upstreamId && h.keyId === f.keyId)
  );
  const winner = parseWinner(body.winner);
  const usage = parseUsage(body.usage);

  // 健康标记：分 mode（见 lib/device/report.ts，含 suppressHealth 语义）
  const health = createProxyDeps().health;
  if (health) {
    const actions = planHealthActions({
      mode: plan.mode as never,
      hops,
      failures,
      winner: winner && hops.some((h) => h.hopIndex === winner.hopIndex) ? winner : null,
    });
    for (const action of actions) {
      if (action.type === "markUnhealthy") await health.markUnhealthy(action.upstreamId);
      else if (action.type === "markHealthy") await health.markHealthy?.(action.upstreamId);
      else if (action.type === "markModelUnhealthy")
        await health.markModelUnhealthy?.(action.upstreamId, action.model);
      else await health.markModelHealthy?.(action.upstreamId, action.model);
    }
  }

  // usage 只写 ok；client_aborted / stream_interrupted 按现状不估算、不写 usage（只留状态行）。
  // 例外：业务 4xx 透传（status=failed + 零 token 的 hasUsage:false）也要写一条 no_usage 行
  // —— 直连在 fallbackBusinessResponse / lastResponse 路径上同样会写。
  if (usage !== null && plan.virtualKeyId !== null) {
    const winnerHop = winner ? hops.find((h) => h.hopIndex === winner.hopIndex) ?? null : null;
    if (winnerHop) {
      const [upstream, vk] = await Promise.all([
        withSkipCache(async () => {
          const rows = await db
            .select({ name: upstreamsTable.name })
            .from(upstreamsTable)
            .where(eq(upstreamsTable.id, winnerHop.upstreamId));
          return rows[0] ?? null;
        }),
        withSkipCache(async () => {
          const rows = await db
            .select({ name: virtualKeysTable.name })
            .from(virtualKeysTable)
            .where(eq(virtualKeysTable.id, plan.virtualKeyId));
          return rows[0] ?? null;
        }),
      ]);
      await withSkipCache(async () => {
        await db.insert(tokenRecords).values({
          model: winnerHop.realModel ?? plan.requestModel ?? "unknown",
          provider: upstream?.name ?? "unknown",
          agent: vk?.name ?? "unknown",
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          status: usage.hasUsage ? null : "no_usage",
          latencyMs: intOrNull(body.latencyMs),
          ttftMs: intOrNull(body.ttftMs),
          virtualKeyId: plan.virtualKeyId,
          userAgent: plan.userAgent ?? null,
          sessionId: plan.recordSessionId ?? null,
          requestModel: plan.requestModel ?? null,
          deviceId: device.id,
        });
      });
    }
  }

  const responseId = typeof body.responseId === "string" ? body.responseId.slice(0, 256) : null;
  if (responseId && plan.virtualKeyId !== null) {
    await saveResponseBinding(responseId, plan.virtualKeyId).catch(() => {});
  }

  invalidateQueryCache();
  return NextResponse.json({ ok: true });
});

function parseHops(raw: string): ReportHop[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const hops: ReportHop[] = [];
    for (const item of parsed) {
      const h = item as Record<string, unknown>;
      if (
        typeof h.hopIndex === "number" &&
        typeof h.upstreamId === "number" &&
        typeof h.keyId === "number"
      ) {
        hops.push({
          hopIndex: h.hopIndex,
          upstreamId: h.upstreamId,
          keyId: h.keyId,
          realModel: typeof h.realModel === "string" ? h.realModel : null,
        });
      }
    }
    return hops;
  } catch {
    return [];
  }
}

function parseFailures(value: unknown): ReportFailure[] {
  if (!Array.isArray(value)) return [];
  const out: ReportFailure[] = [];
  for (const item of value.slice(0, 64)) {
    if (typeof item !== "object" || item === null) continue;
    const f = item as Record<string, unknown>;
    if (typeof f.hopIndex !== "number" || typeof f.upstreamId !== "number" || typeof f.keyId !== "number") {
      continue;
    }
    const cause =
      f.cause === "timeout" || f.cause === "network" ? (f.cause as "timeout" | "network") : "http";
    const bodyKind =
      f.bodyKind === "json" || f.bodyKind === "html" ? (f.bodyKind as "json" | "html") : "other";
    out.push({
      hopIndex: f.hopIndex,
      upstreamId: f.upstreamId,
      keyId: f.keyId,
      status: intOrNull(f.status),
      bodyKind,
      cause,
    });
  }
  return out;
}

function parseWinner(value: unknown): ReportWinner | null {
  if (typeof value !== "object" || value === null) return null;
  const w = value as Record<string, unknown>;
  if (typeof w.hopIndex !== "number" || typeof w.upstreamId !== "number" || typeof w.keyId !== "number") {
    return null;
  }
  return { hopIndex: w.hopIndex, upstreamId: w.upstreamId, keyId: w.keyId };
}

function parseUsage(value: unknown): {
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  hasUsage: boolean;
} | null {
  if (typeof value !== "object" || value === null) return null;
  const u = value as Record<string, unknown>;
  return {
    inputTokens: intOrNull(u.inputTokens) ?? 0,
    outputTokens: intOrNull(u.outputTokens) ?? 0,
    cacheRead: intOrNull(u.cacheRead) ?? 0,
    cacheWrite: intOrNull(u.cacheWrite) ?? 0,
    hasUsage: u.hasUsage === true,
  };
}
