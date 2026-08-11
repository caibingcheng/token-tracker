import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import {
  isTotpEnabled,
  getTotpSecret,
  setTotpSecret,
  setTotpEnabled,
  clearTotp,
  getSetting,
  setSetting,
  deleteSetting,
} from "@/lib/auth/settings";
import {
  generateTotpSecret,
  verifyTotpCode,
  buildOtpAuthUri,
} from "@/lib/auth/totp";
import {
  isTotpLocked,
  recordTotpFailure,
  clearTotpFailures,
} from "@/lib/auth/totp-lock";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

const PENDING_SECRET_KEY = "totp_pending_secret";

export const GET = withAuth(async () => {
  const enabled = await isTotpEnabled();
  const pending = (await getSetting(PENDING_SECRET_KEY)) !== null;
  return NextResponse.json({ success: true, data: { totpEnabled: enabled, pendingSecret: pending } });
});

// POST 无 action（或 action: "generate"）：生成新 secret 存入 pending，返回 otpauth URI 供二维码/手动录入
// POST { code }：校验 pending secret 并启用 TOTP
export const POST = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // 无 body 视为生成 secret
  }

  if (typeof body.code === "string" && body.code) {
    const pending = await getSetting(PENDING_SECRET_KEY);
    if (!pending) {
      return NextResponse.json(
        { success: false, error: "No pending TOTP secret. Generate one first" },
        { status: 400 }
      );
    }
    if (!verifyTotpCode(pending, body.code.trim())) {
      if (await isTotpLocked()) {
        return NextResponse.json(
          { success: false, error: "Account temporarily locked, try again later" },
          { status: 429 }
        );
      }
      await recordTotpFailure();
      return NextResponse.json(
        { success: false, error: "Invalid TOTP code" },
        { status: 400 }
      );
    }
    await clearTotpFailures();
    await setTotpSecret(pending);
    await setTotpEnabled(true);
    await deleteSetting(PENDING_SECRET_KEY);
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "totp_enabled",
      targetType: "system",
      ip,
      userAgent,
      details: {},
    });
    return NextResponse.json({ success: true, data: { totpEnabled: true } });
  }

  const secret = generateTotpSecret();
  await setSetting(PENDING_SECRET_KEY, secret);
  const uri = buildOtpAuthUri(secret, "Token Tracker", "admin");
  return NextResponse.json({ success: true, data: { secret, otpauthUri: uri } });
});

// 解绑：需提供当前 TOTP 动态码
export const DELETE = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const code = typeof body.code === "string" ? body.code.trim() : "";
  if (!code) {
    return NextResponse.json({ success: false, error: "TOTP code required" }, { status: 400 });
  }

  if (!(await isTotpEnabled())) {
    return NextResponse.json({ success: true, data: { totpEnabled: false } });
  }

  const secret = await getTotpSecret();
  if (!secret || !verifyTotpCode(secret, code)) {
    if (await isTotpLocked()) {
      return NextResponse.json(
        { success: false, error: "Account temporarily locked, try again later" },
        { status: 429 }
      );
    }
    await recordTotpFailure();
    return NextResponse.json({ success: false, error: "Invalid TOTP code" }, { status: 400 });
  }
  await clearTotpFailures();

  await clearTotp();
  await deleteSetting(PENDING_SECRET_KEY);
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "totp_disabled",
    targetType: "system",
    ip,
    userAgent,
    details: {},
  });
  return NextResponse.json({ success: true, data: { totpEnabled: false } });
});
