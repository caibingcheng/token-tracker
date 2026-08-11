import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import {
  setAdminApiKey,
  bumpTokenEpoch,
  isTotpEnabled,
  getTotpSecret,
} from "@/lib/auth/settings";
import { verifyTotpCode } from "@/lib/auth/totp";
import { isStrongLoginKey } from "@/lib/auth/setup";
import {
  isTotpLocked,
  recordTotpFailure,
  clearTotpFailures,
} from "@/lib/auth/totp-lock";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

// 修改登录 key（DB 持久化；env ADMIN_API_KEY / API_KEYS 立即不再被检查）：
// 写入新 key + token_epoch + 1 → 所有已签发会话 token 立即失效。
// 若 TOTP 已启用，必须提供当前动态码验证。
export const PATCH = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const newKey = typeof body.newApiKey === "string" ? body.newApiKey.trim() : "";
  if (!isStrongLoginKey(newKey)) {
    return NextResponse.json(
      { success: false, error: "newApiKey must be at least 16 characters and contain at least 2 character classes (upper/lower/digit/symbol)" },
      { status: 400 }
    );
  }

  if (await isTotpEnabled()) {
    const code = typeof body.totpCode === "string" ? body.totpCode.trim() : "";
    const secret = await getTotpSecret();
    if (!secret || !verifyTotpCode(secret, code)) {
      if (await isTotpLocked()) {
        return NextResponse.json(
          { success: false, error: "Account temporarily locked, try again later" },
          { status: 429 }
        );
      }
      await recordTotpFailure();
      return NextResponse.json(
        { success: false, error: "Invalid TOTP code" },
        { status: 401 }
      );
    }
    await clearTotpFailures();
  }

  await setAdminApiKey(newKey);
  const epoch = await bumpTokenEpoch();

  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "api_key_changed",
    targetType: "system",
    ip,
    userAgent,
    details: {},
  });

  return NextResponse.json({
    success: true,
    data: { tokenEpoch: epoch, note: "All existing sessions have been revoked. Re-login with the new key" },
  });
});
