import { NextRequest, NextResponse } from "next/server";
import { safeCompare } from "@/lib/gateway/crypto";
import {
  getTokenEpoch,
  getAdminApiKey,
  isTotpEnabled,
  getTotpSecret,
} from "@/lib/auth/settings";
import {
  signSessionToken,
  getSessionTtlMs,
  keyFingerprint,
} from "@/lib/auth/session";
import { verifyTotpCode } from "@/lib/auth/totp";

// 内存滑动窗口限流：按 IP + key 前缀计数，防爆破登录 key 与 TOTP
const WINDOW_MS = 15 * 60 * 1000;
const MAX_ATTEMPTS = 10;
const attempts = new Map<string, number[]>();

function rateLimited(key: string): boolean {
  const now = Date.now();
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

function getClientIp(request: NextRequest): string {
  return (
    request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    request.headers.get("x-real-ip") ??
    "unknown"
  );
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

  const ip = getClientIp(request);
  if (rateLimited(`${ip}:key`)) {
    return NextResponse.json(
      { success: false, error: "Too many attempts, try again later" },
      { status: 429 }
    );
  }

  // 登录 key 校验：DB 优先，env API_KEYS 兜底（仅 bootstrap 场景）
  let matchedKey: string | null = null;
  const dbKey = await getAdminApiKey();
  if (dbKey !== null) {
    if (safeCompare(apiKey, dbKey)) matchedKey = dbKey;
  } else {
    const envKeys =
      process.env.API_KEYS?.split(",")
        .map((k) => k.trim())
        .filter(Boolean) ?? [];
    matchedKey = envKeys.find((k) => safeCompare(k, apiKey)) ?? null;
  }

  if (!matchedKey) {
    return NextResponse.json(
      { success: false, error: "Invalid API key" },
      { status: 401 }
    );
  }

  // TOTP：启用后必须提供正确的 6 位动态码
  if (await isTotpEnabled()) {
    const secret = await getTotpSecret();
    if (!secret || !totpCode || !verifyTotpCode(secret, totpCode)) {
      return NextResponse.json(
        { success: false, error: "TOTP code required or invalid", totpRequired: true },
        { status: 401 }
      );
    }
  }

  resetAttempts(`${ip}:key`);

  const epoch = await getTokenEpoch();
  const token = signSessionToken(epoch, keyFingerprint(matchedKey));
  return NextResponse.json({
    success: true,
    token,
    expiresInMs: getSessionTtlMs(),
  });
}
