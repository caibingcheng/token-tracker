import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { refreshSnapshot, type ModelsDevFetchError } from "@/lib/models-dev/snapshot";

// 强制刷新 models.dev 快照（拉取失败回退旧快照，按失败分类返回错误文案供 UI 提示）

export const dynamic = "force-dynamic";

function describeRefreshError(error: ModelsDevFetchError): string {
  switch (error.kind) {
    case "network":
      return "Failed to fetch models.dev data: network error (make sure the server can reach https://models.dev/api.json — use Upload… to apply a snapshot file as a workaround)";
    case "http":
      return `Failed to fetch models.dev data: upstream responded with HTTP ${error.status ?? "unknown status"} — use Upload… to apply a snapshot file as a workaround`;
    case "invalid":
      return "Failed to fetch models.dev data: invalid response shape — use Upload… to apply a snapshot file as a workaround";
  }
}

export const POST = withAuth(async (request: NextRequest) => {
  const result = await refreshSnapshot();
  if (!result.ok) {
    return NextResponse.json(
      { success: false, error: describeRefreshError(result.error) },
      { status: 502 }
    );
  }
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "models_dev_refresh",
    targetType: "system",
    ip,
    userAgent,
    details: { fetchedAt: result.snapshot.fetchedAt },
  });
  return NextResponse.json({ success: true, data: { fetchedAt: result.snapshot.fetchedAt } });
});
