import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { syncPusher } from "@/lib/sync/pusher";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { NextRequest } from "next/server";

// 手动触发同步：立即尝试一轮推送（不等待定时器）
export const POST = withAuth(async (request: NextRequest) => {
  try {
    await syncPusher.trigger();
  } catch (err) {
    console.error("[sync] manual trigger failed:", err);
    return NextResponse.json({ success: false, error: "Sync failed" }, { status: 500 });
  }
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "sync_triggered",
    targetType: "sync",
    ip,
    userAgent,
  });
  return NextResponse.json({ success: true });
});