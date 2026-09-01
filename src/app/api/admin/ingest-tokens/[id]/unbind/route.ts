import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import { unbindIngestToken } from "@/lib/ingest/tokens";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

type RouteCtx = { params: Record<string, string> };

export const POST = withAuth(async (request: NextRequest, ctx: RouteCtx) => {
  return withSkipCache(async () => {
    const tokenId = Number(ctx.params.id);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid token id" }, { status: 400 });
    }

    const changed = await unbindIngestToken(tokenId);
    if (!changed) {
      return NextResponse.json({ success: false, error: "Ingest token not found" }, { status: 404 });
    }

    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "ingest_token_unbound",
      targetType: "ingest_token",
      targetId: tokenId,
      ip,
      userAgent,
    });

    return NextResponse.json({ success: true });
  });
});