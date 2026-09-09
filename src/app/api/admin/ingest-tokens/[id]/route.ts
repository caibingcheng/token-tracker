import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import { updateIngestToken } from "@/lib/ingest/tokens";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

type RouteCtx = { params: Record<string, string> };

export const PATCH = withAuth(async (request: NextRequest, ctx: RouteCtx) => {
  return withSkipCache(async () => {
    const tokenId = Number(ctx.params.id);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid token id" }, { status: 400 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const patch: { name?: string; enabled?: boolean } = {};
    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > 64) {
        return NextResponse.json(
          { success: false, error: "name must be a non-empty string (max 64 chars)" },
          { status: 400 }
        );
      }
      patch.name = name;
    }
    if (body.enabled !== undefined) {
      if (typeof body.enabled !== "boolean") {
        return NextResponse.json({ success: false, error: "enabled must be a boolean" }, { status: 400 });
      }
      patch.enabled = body.enabled;
    }

    if (Object.keys(patch).length === 0) {
      return NextResponse.json(
        { success: false, error: "No fields to update (name or enabled)" },
        { status: 400 }
      );
    }

    const changed = await updateIngestToken(tokenId, patch);
    if (!changed) {
      return NextResponse.json({ success: false, error: "Ingest token not found" }, { status: 404 });
    }

    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "ingest_token_updated",
      targetType: "ingest_token",
      targetId: tokenId,
      ip,
      userAgent,
      details: patch,
    });

    return NextResponse.json({ success: true });
  });
});

export const DELETE = withAuth(async (request: NextRequest, ctx: RouteCtx) => {
  return withSkipCache(async () => {
    const tokenId = Number(ctx.params.id);
    if (!Number.isInteger(tokenId) || tokenId <= 0) {
      return NextResponse.json({ success: false, error: "Invalid token id" }, { status: 400 });
    }

    const changed = await updateIngestToken(tokenId, null);
    if (!changed) {
      return NextResponse.json({ success: false, error: "Ingest token not found" }, { status: 404 });
    }

    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "ingest_token_deleted",
      targetType: "ingest_token",
      targetId: tokenId,
      ip,
      userAgent,
    });

    return NextResponse.json({ success: true });
  });
});