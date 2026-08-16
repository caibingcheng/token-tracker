import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { refreshSnapshot } from "@/lib/models-dev/snapshot";

// 强制刷新 models.dev 快照（拉取失败回退旧快照，返回 fetchedAt 供 UI 判断）

export const dynamic = "force-dynamic";

export const POST = withAuth(async (request: NextRequest) => {
  const snapshot = await refreshSnapshot();
  if (!snapshot) {
    return NextResponse.json(
      { success: false, error: "Failed to fetch models.dev data (check network / GATEWAY_SECRET env)" },
      { status: 502 }
    );
  }
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "models_dev_refresh",
    targetType: "system",
    ip,
    userAgent,
    details: { fetchedAt: snapshot.fetchedAt },
  });
  return NextResponse.json({ success: true, data: { fetchedAt: snapshot.fetchedAt } });
});
