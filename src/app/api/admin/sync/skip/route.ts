import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import {
  loadSyncConfig,
  setSyncCursor,
  incrementDroppedCount,
} from "@/lib/sync/config";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

// 手动跳过：强制推进游标丢弃区间 [cursor+1, upToRecordId]
export const POST = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const upToRecordId = body.upToRecordId;
    if (typeof upToRecordId !== "number" || !Number.isInteger(upToRecordId) || upToRecordId <= 0) {
      return NextResponse.json(
        { success: false, error: "upToRecordId must be a positive integer" },
        { status: 400 }
      );
    }

    const config = await loadSyncConfig();
    if (upToRecordId <= config.cursor) {
      return NextResponse.json(
        { success: false, error: "upToRecordId must be greater than current cursor" },
        { status: 400 }
      );
    }

    await setSyncCursor(upToRecordId);
    await incrementDroppedCount(upToRecordId - config.cursor);

    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "sync_skip",
      targetType: "sync",
      ip,
      userAgent,
      details: { upToRecordId, fromCursor: config.cursor },
    });

    return NextResponse.json({ success: true });
  });
});