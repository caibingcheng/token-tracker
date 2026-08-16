import { NextRequest, NextResponse } from "next/server";
import { safeCompare } from "@/lib/gateway/crypto";
import { getRateLimitKey } from "@/lib/net/client-ip";
import {
  getTokenEpoch,
  getAdminApiKey,
  getEnvAdminKeys,
  isTotpEnabled,
  getTotpSecret,
  resolveSessionTtlMs,
} from "@/lib/auth/settings";
import {
  signSessionToken,
  keyFingerprint,
} from "@/lib/auth/session";
import { verifyTotpCode } from "@/lib/auth/totp";
import {
  isTotpLocked,
  recordTotpFailure,
  clearTotpFailures,
} from "@/lib/auth/totp-lock";
import {
  classifySecondFactorInput,
  verifyRecoveryCode,
  getRemainingRecoveryCodes,
  setRecoveryCodeReminder,
} from "@/lib/auth/recovery-codes";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

// 内存滑动窗口限流：按可信 IP 计数（默认全局桶，防 XFF 伪造绕过），防爆破登录 key 与 TOTP
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, number[]>();
let sweepCounter = 0;

function rateLimited(key: string): boolean {
  const now = Date.now();
  // 惰性清扫：每 64 次调用清理一次过期条目，防伪造 key 无界增长
  sweepCounter++;
  if (sweepCounter % 64 === 0) {
    attempts.forEach((ts, k) => {
      if (ts.length === 0 || now - ts[ts.length - 1]! >= WINDOW_MS) {
        attempts.delete(k);
      }
    });
  }
  const timestamps = (attempts.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  if (timestamps.length >= MAX_ATTEMPTS) {
    attempts.set(key, timestamps);
    return true;
  }
  timestamps.push(now);
  attempts.set(key, timestamps);
  return false;
}

function resetAttempts(key: string): void {
  attempts.delete(key);
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  const totpCode = typeof body.totpCode === "string" ? body.totpCode.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ success: false, error: "Missing apiKey" }, { status: 400 });
  }

  const rateKey = getRateLimitKey(request);
  if (rateLimited(rateKey)) {
    return NextResponse.json(
      { success: false, error: "Too many attempts, try again later" },
      { status: 429 }
    );
  }

  // 登录 key 校验：DB 优先，env ADMIN_API_KEY / API_KEYS 兜底（仅 bootstrap 场景）
  let matchedKey: string | null = null;
  const dbKey = await getAdminApiKey();
  if (dbKey !== null) {
    if (safeCompare(apiKey, dbKey)) matchedKey = dbKey;
  } else {
    matchedKey = getEnvAdminKeys().find((k) => safeCompare(k, apiKey)) ?? null;
  }

  if (!matchedKey) {
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "login_failure",
      targetType: "system",
      ip,
      userAgent,
      details: { reason: "invalid_api_key" },
    });
    // 统一 401 文案：不区分 key 无效 / 缺 TOTP / TOTP 错误，消除 key 有效性 oracle
    return NextResponse.json(
      { success: false, error: "Invalid credentials" },
      { status: 401 }
    );
  }

  // TOTP：启用后必须提供正确的动态码（6 位）或 recovery code（16 位一次性备用码）。
  // 分流规则：6 位纯数字 → TOTP；归一化后 16 位合法 → recovery；否则走 TOTP 分支（必然失败 → 统一 401）
  if (await isTotpEnabled()) {
    const secondFactorKind = classifySecondFactorInput(totpCode);

    // Recovery code 路径：可绕过 TOTP 锁定（设备丢失时唯一备用入口）；
    // 失败不计入 totp_fail_count，由 login 全局限流桶统一计数（不新增独立 bucket）
    if (secondFactorKind === "recovery") {
      if (await verifyRecoveryCode(totpCode)) {
        await clearTotpFailures();
        await setRecoveryCodeReminder();
        const remaining = await getRemainingRecoveryCodes();
        resetAttempts(rateKey);
        const { ip: auditIp, userAgent } = extractClientInfo(request);
        await recordAuditLog({
          action: "login_success",
          targetType: "system",
          ip: auditIp,
          userAgent,
          details: {
            totp: true,
            via_recovery_code: true,
            remaining_recovery_codes: remaining,
          },
        });
        const epoch = await getTokenEpoch();
        const ttlMs = await resolveSessionTtlMs();
        const token = signSessionToken(epoch, keyFingerprint(matchedKey), ttlMs);
        return NextResponse.json({
          success: true,
          token,
          expiresInMs: ttlMs,
          viaRecoveryCode: true,
        });
      }
      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "login_failure",
        targetType: "system",
        ip,
        userAgent,
        details: { reason: "invalid_recovery_code" },
      });
      return NextResponse.json(
        { success: false, error: "Invalid credentials" },
        { status: 401 }
      );
    }

    // TOTP 分支（含 invalid 输入，统一 401 文案消除第二因素有效性 oracle）
    const lockedUntil = await isTotpLocked();
    if (lockedUntil !== null) {
      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "login_failure",
        targetType: "system",
        ip,
        userAgent,
        details: { reason: "totp_locked", lockedUntil },
      });
      return NextResponse.json(
        { success: false, error: "Account temporarily locked, try again later" },
        { status: 429 }
      );
    }
    const secret = await getTotpSecret();
    if (!secret || !verifyTotpCode(secret, totpCode)) {
      await recordTotpFailure();
      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "login_failure",
        targetType: "system",
        ip,
        userAgent,
        details: { reason: "invalid_totp" },
      });
      return NextResponse.json(
        { success: false, error: "Invalid credentials" },
        { status: 401 }
      );
    }
    await clearTotpFailures();
  }

  resetAttempts(rateKey);

  const { ip: auditIp, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "login_success",
    targetType: "system",
    ip: auditIp,
    userAgent,
    details: { totp: await isTotpEnabled() },
  });

  const epoch = await getTokenEpoch();
  const ttlMs = await resolveSessionTtlMs();
  const token = signSessionToken(epoch, keyFingerprint(matchedKey), ttlMs);
  return NextResponse.json({
    success: true,
    token,
    expiresInMs: ttlMs,
  });
}
