import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { bumpTokenEpoch } from "@/lib/auth/settings";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

// 全局登出：token_epoch + 1 → 所有已签发会话 token 立即失效（含正在使用的当前会话）
export const POST = withAuth(async (request: NextRequest) => {
  const epoch = await bumpTokenEpoch();
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "sessions_revoked",
    targetType: "system",
    ip,
    userAgent,
    details: { tokenEpoch: epoch },
  });
  return NextResponse.json({
    success: true,
    data: { tokenEpoch: epoch, note: "All sessions have been revoked. Log in again." },
  });
});
