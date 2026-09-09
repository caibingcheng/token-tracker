import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { resetSyncState } from "@/lib/sync/config";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

// 重置同步状态（A 重建场景）：游标归零 + 重新生成 epoch + 解除本地锁定。
// 纯本地操作，A 不在线也能执行。
export const POST = withAuth(async (request: NextRequest) => {
  await resetSyncState();
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "sync_reset",
    targetType: "sync",
    ip,
    userAgent,
  });
  return NextResponse.json({ success: true });
});