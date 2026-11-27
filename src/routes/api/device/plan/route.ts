// /api/device/plan：relay 每请求一次的「执行计划」。
//
// 中心仍是唯一决策者（路由/配额/健康/写库口径），relay 只拿 hop 列表 + 封装的 key lease。
// 决策逻辑全在 buildPlan()（lib/gateway/plan.ts）；本文件只做：鉴权后的输入校验、
// lease 封装、device_plans 落库（report 侧只能回报 hopIndex，写库素材以这里为准）。
import { NextRequest, NextResponse } from "next/server";
import { withDeviceAuth, type DeviceContext } from "@/lib/auth/device-guard";
import {
  readJsonBodyLimited,
  BodyTooLargeError,
  InvalidJsonBodyError,
} from "@/lib/auth/request-body";
import { createSlidingWindowLimiter } from "@/lib/device/rate-limit";
import { createPlanDeps } from "@/lib/device/plan-deps";
import { resolveVirtualKeyByFingerprint } from "@/lib/device/vk";
import { maybeSweep } from "@/lib/device/store";
import { buildPlan, resolvePlanMode } from "@/lib/gateway/plan";
import type { BuildPlanInput, PlanMode } from "@/lib/gateway/plan";
import { getMaxRequestBodyBytes, stripRawPassthroughPrefix } from "@/lib/gateway/proxy";
import { detectRequestProtocol } from "@/lib/gateway/model-router";
import { applyHeaderTransforms } from "@/lib/gateway/header-transforms";
import { sanitizePathSegments } from "@/lib/gateway/url-utils";
import { LEASE_TTL_MS, sealLease } from "@/lib/gateway/lease";
import { resolveStreamIdleTimeoutMs } from "@/lib/auth/settings";
import { db, devicePlansTable, initDatabase } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { randomBytes } from "crypto";

// relay 版本协商：relay 升级前中心已经升级时，宁可让客户端看到 426 也不要难懂的堆栈
export const MIN_RELAY_VERSION = "1.0.0";
const PLAN_BODY_LIMIT = 8 * 1024;
// plan 每请求真读 DB → 每设备进程内限流（§12.4，不计入 vk 配额）
const limiter = createSlidingWindowLimiter({ windowMs: 1000, max: 20 });
const PLAN_TTL_MS = 10 * 60 * 1000;
const MAX_PLAN_HOPS = 40; // ≤8 upstream × ≤5 key（§18）
const POLICY_CENTER_MAX_RESPONSE_BUFFER_MB = 50;

class BadRequest extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
  }
}

function planError(status: number, type: string, message: string) {
  return NextResponse.json({ error: { message, type } }, { status, headers: { "cache-control": "no-store" } });
}

function isVersionAtLeast(actual: string, required: string): boolean {
  const a = actual.split(".").map((n) => Number.parseInt(n, 10));
  const b = required.split(".").map((n) => Number.parseInt(n, 10));
  for (let i = 0; i < 3; i++) {
    const x = Number.isFinite(a[i]) ? a[i]! : 0;
    const y = Number.isFinite(b[i]) ? b[i]! : 0;
    if (x !== y) return x > y;
  }
  return true;
}

function optionalString(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value;
  return trimmed === "" ? null : trimmed.slice(0, max);
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function nonNegativeInt(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.min(Math.floor(n), Number.MAX_SAFE_INTEGER);
}

function headerNamesOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") continue;
    const name = item.trim().toLowerCase();
    if (!/^[a-z0-9!#$%&'*+\-.^_`|~]{1,64}$/.test(name)) continue;
    if (out.includes(name)) continue;
    out.push(name);
    if (out.length >= 64) break;
  }
  return out;
}

// header transforms 在中心求值（变量 sessionId/model/keyName/upstream 中心都有）：
// 结果只含 transform 写出的 header（relay 自己转发客户端 header，不在这里重复）。
// clientHeaderNames 只用于 fill/override 的「客户端是否已带」判定（relay 只报 header 名，不报值）。
//
// 为什么不能靠对比 shim 前后的值：transform 可以合法地把 header 写成空串（值校验只限长度上限），
// 用「值非空」判产物会把它当成「未改动」吞掉。这里用「哪些 transform 实际生效」逐一取值。
function leaseHeaders(
  transforms: import("@/lib/gateway/header-transforms").HeaderTransform[],
  vars: { sessionId: string; model: string; keyName: string; upstream: string },
  clientHeaderNames: string[]
): Record<string, string> {
  if (transforms.length === 0) return {};
  const preexisting = new Set(clientHeaderNames.map((name) => name.toLowerCase()));
  // 占位值必须是合法 header 值（NUL 等控制字符会被 Headers 直接拒）；这里只借它做变量展开
  const scratch = new Headers();
  for (const name of clientHeaderNames) scratch.set(name, "-");
  applyHeaderTransforms(scratch, transforms, vars);
  const out: Record<string, string> = {};
  for (const t of transforms) {
    if (!t.enabled) continue;
    const name = t.header.toLowerCase();
    // fill 的「缺失」基准 = transforms 应用前的 header 集（与 applyHeaderTransforms 同口径）
    if (t.mode === "fill" && preexisting.has(name)) continue;
    out[name] = scratch.get(name) ?? "";
  }
  return out;
}

export const POST = withDeviceAuth(async (request: NextRequest, device: DeviceContext) => {
  void maybeSweep().catch(() => {});
  if (limiter.hit(String(device.id))) {
    return planError(429, "rate_limited", "Too many plan requests");
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyLimited(request, PLAN_BODY_LIMIT);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return planError(413, "invalid_request_error", "Request body too large");
    }
    if (err instanceof InvalidJsonBodyError) {
      return planError(400, "invalid_request_error", "Invalid JSON body");
    }
    throw err;
  }

  const relayVersion = optionalString(body.relayVersion, 32) ?? "0.0.0";
  if (!isVersionAtLeast(relayVersion, MIN_RELAY_VERSION)) {
    return planError(426, "relay_too_old", `relay ${relayVersion} is older than ${MIN_RELAY_VERSION}`);
  }

  try {
    const now = Date.now();
    const vkFp = optionalString(body.vkFp, 128);
    if (!vkFp) throw new BadRequest("invalid_request_error", "vkFp is required");
    const virtualKey = await resolveVirtualKeyByFingerprint(vkFp);
    if (!virtualKey || !virtualKey.enabled) {
      // 与直连同码同文案（proxy.ts 的 invalid_api_key 口径）
      return planError(401, "invalid_api_key", "Invalid or revoked virtual key");
    }

    const rawPath = optionalString(body.path, 4096);
    if (!rawPath) throw new BadRequest("invalid_request_error", "path is required");
    if (/%2f|%5c/i.test(rawPath.split("?")[0] ?? "")) {
      throw new BadRequest("invalid_request_error", "Invalid request path");
    }
    const sanitized = sanitizePathSegments(rawPath.split("?")[0] ?? "");
    if (sanitized === null) throw new BadRequest("invalid_request_error", "Invalid request path");
    const path = stripRawPassthroughPrefix(sanitized);
    if (path === null) throw new BadRequest("invalid_request_error", "Invalid request path");
    const queryIndex = rawPath.indexOf("?");
    const fullPath = queryIndex >= 0 ? `${path}${rawPath.slice(queryIndex)}` : path;

    // mode 由 path 派生（不信任 relay 自报；models 是唯一 GET）
    const pathname = fullPath.split("?")[0]!;
    const mode: PlanMode = resolvePlanMode(
      pathname.endsWith("/models") ? "GET" : "POST",
      pathname
    );

    const input: BuildPlanInput = {
      deviceId: device.id,
      virtualKey,
      mode,
      protocol: detectRequestProtocol(pathname),
      path: fullPath,
      model: mode === "router" || mode === "responses-create"
        ? optionalString(body.model, 256)
        : null,
      responseId: optionalString(body.responseId, 256),
      nativeSessionId: optionalString(body.nativeSessionId, 256),
      sessionInput: typeof body.sessionInput === "string" ? body.sessionInput.slice(0, 2048) : null,
      hasMessages: body.hasMessages === true,
      stream: optionalBoolean(body.stream),
      userAgent: optionalString(body.userAgent, 512),
      estimatedInputTokens: nonNegativeInt(body.estimatedInputTokens),
    };

    const { deps: planDeps, apiKeyOf } = createPlanDeps();
    const result = await buildPlan(input, planDeps, now);
    if (!result.ok) {
      return planError(result.status, result.error.type, result.error.message);
    }

    if (result.hops.length > MAX_PLAN_HOPS) {
      console.log(
        `[relay] plan truncated: ${result.hops.length} hops > ${MAX_PLAN_HOPS} (device ${device.id})`
      );
    }
    const hops = result.hops.slice(0, MAX_PLAN_HOPS);
    const planId = randomBytes(12).toString("base64url");
    const expiresAt = now + PLAN_TTL_MS;
    const leaseExpiresAt = Math.min(expiresAt, now + LEASE_TTL_MS);
    const headerNames = headerNamesOf(body.headerNames);

    const wireHops = hops.map((hop) => {
      const apiKey = apiKeyOf(hop.keyId);
      if (apiKey === null) throw new Error(`plan: key ${hop.keyId} not resolved`);
      return {
        hopIndex: hop.hopIndex,
        upstreamId: hop.upstreamId,
        keyId: hop.keyId,
        keyLease: sealLease(
          {
            v: 1,
            planId,
            upstreamId: hop.upstreamId,
            keyId: hop.keyId,
            apiKey,
            protocol: input.protocol,
            url: hop.url,
            proxyUrl: hop.proxyUrl,
            headers: leaseHeaders(
              hop.headerTransforms,
              {
                sessionId: result.sessionId,
                model: hop.realModel ?? "",
                keyName: virtualKey.name,
                upstream: hop.upstreamName,
              },
              headerNames
            ),
            requiresPrivateNetwork: hop.requiresPrivateNetwork,
            expiresAt: leaseExpiresAt,
          },
          device.publicKey
        ),
        leaseExpiresAt,
        realModel: hop.realModel,
        retries: hop.retries,
        continueOn: hop.continueOn,
        stopOn: hop.stopOn,
        passthrough: hop.passthrough,
        timeoutMs: hop.timeoutMs,
        suppressHealth: hop.suppressHealth,
        skipSiblingsOn: hop.skipSiblingsOn,
      };
    });

    await initDatabase();
    await withSkipCache(async () => {
      await db.insert(devicePlansTable).values({
        planId,
        deviceId: device.id,
        virtualKeyId: virtualKey.id,
        hopsJson: JSON.stringify(
          hops.map((h) => ({
            hopIndex: h.hopIndex,
            upstreamId: h.upstreamId,
            keyId: h.keyId,
            realModel: h.realModel,
          }))
        ),
        mode: input.mode,
        protocol: input.protocol,
        requestModel: input.model,
        userAgent: input.userAgent,
        sessionId: result.routeSessionId,
        recordSessionId: result.recordSessionId,
        reservedTokens: result.quota.reservedTokens,
        reservedRpm: result.quota.reservedRpm,
        createdAt: new Date(now).toISOString(),
        expiresAt,
      });
    });

    const idleMs = await resolveStreamIdleTimeoutMs().catch(() => 30 * 60 * 1000);

    return NextResponse.json(
      {
        planId,
        expiresAt,
        quota: result.quota,
        hops: wireHops,
        modelsSnapshot: result.modelsSnapshot ?? null,
        // 中心的权威设备名：relay 用它显示（/pair 页 + 日志），中心的改名/重命名无需额外心跳
        // 就能在下次 plan 时到达 relay。id 仅供 relay 日志排障，不参与任何授权判断。
        device: { id: device.id, name: device.name },
        policy: {
          streamIdleTimeoutMinutes: Math.max(1, Math.round(idleMs / 60000)),
          centerMaxBodyMb: Math.floor(getMaxRequestBodyBytes() / (1024 * 1024)),
          centerMaxResponseBufferMb: POLICY_CENTER_MAX_RESPONSE_BUFFER_MB,
        },
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof BadRequest) return planError(400, err.code, err.message);
    throw err;
  }
});
