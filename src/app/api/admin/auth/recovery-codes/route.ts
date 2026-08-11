import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { getTotpSecret } from "@/lib/auth/settings";
import { verifyTotpCode } from "@/lib/auth/totp";
import {
  isTotpLocked,
  recordTotpFailure,
  clearTotpFailures,
} from "@/lib/auth/totp-lock";
import {
  generateRecoveryCodes,
  setRecoveryCodes,
  getRemainingRecoveryCodes,
  hasRecoveryCodes,
  getRecoveryCodeReminder,
  clearRecoveryCodeReminder,
} from "@/lib/auth/recovery-codes";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

// GET：恢复码剩余数量与登录提醒标记（reminder 供 Security 面板横幅展示）
export const GET = withAuth(async () => {
  const remaining = await getRemainingRecoveryCodes();
  const reminder = await getRecoveryCodeReminder();
  // exists：区分「从未生成」与「全部用完」（面板两种横幅状态）
  const exists = await hasRecoveryCodes();
  return NextResponse.json({ success: true, data: { remaining, reminder, exists } });
});

// POST：重新生成 4 个 recovery codes，需当前 TOTP 验证。
// 不修改 totp_secret、不吊销会话，仅替换恢复码本身
export const POST = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown> = {};
  try {
    body = await request.json();
  } catch {
    // 无 body 视为缺少 currentCode
  }

  const currentCode =
    typeof body.currentCode === "string" ? body.currentCode.trim() : "";
  if (!currentCode) {
    return NextResponse.json(
      { success: false, error: "TOTP code required" },
      { status: 400 }
    );
  }
  if (await isTotpLocked()) {
    return NextResponse.json(
      { success: false, error: "Account temporarily locked, try again later" },
      { status: 429 }
    );
  }
  const secret = await getTotpSecret();
  if (!secret || !verifyTotpCode(secret, currentCode)) {
    await recordTotpFailure();
    return NextResponse.json(
      { success: false, error: "Invalid TOTP code" },
      { status: 400 }
    );
  }
  await clearTotpFailures();

  const codes = generateRecoveryCodes(4);
  await setRecoveryCodes(codes);
  await clearRecoveryCodeReminder();

  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "recovery_codes_regenerated",
    targetType: "system",
    ip,
    userAgent,
    details: {},
  });
  return NextResponse.json({ success: true, data: { recoveryCodes: codes } });
});
