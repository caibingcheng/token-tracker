import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, initDatabase, namedRouteTargetsTable, namedRoutesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { MAX_DESCRIPTION_LENGTH, parsePriority } from "@/lib/admin/named-routes";

interface Params {
  params: { id: string; targetId: string };
}

async function findRouteAndTarget(routeId: number, targetId: number) {
  const route = (
    await db.select().from(namedRoutesTable).where(eq(namedRoutesTable.id, routeId))
  )[0];
  if (!route) return { route: null, target: null };
  const target = (
    await db
      .select()
      .from(namedRouteTargetsTable)
      .where(
        and(
          eq(namedRouteTargetsTable.id, targetId),
          eq(namedRouteTargetsTable.namedRouteId, routeId)
        )
      )
  )[0];
  return { route, target: target ?? null };
}

// PATCH：编辑目标（targetModel / description / priority；upstream 改动 = 删旧建新）
export const PATCH = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const routeId = Number(params.id);
    const targetId = Number(params.targetId);
    const { route, target } = await findRouteAndTarget(routeId, targetId);
    if (!route) {
      return NextResponse.json({ success: false, error: "Named route not found" }, { status: 404 });
    }
    if (!target) {
      return NextResponse.json({ success: false, error: "Target not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const set: Partial<{ upstreamModel: string; description: string | null; priority: number }> = {};
    if (body.targetModel !== undefined) {
      const targetModel = typeof body.targetModel === "string" ? body.targetModel.trim() : "";
      if (!targetModel) {
        return NextResponse.json(
          { success: false, error: "targetModel must be a non-empty string" },
          { status: 400 }
        );
      }
      set.upstreamModel = targetModel;
    }
    if (body.description !== undefined) {
      if (body.description !== null && typeof body.description !== "string") {
        return NextResponse.json(
          { success: false, error: "description must be a string or null" },
          { status: 400 }
        );
      }
      const trimmed = typeof body.description === "string" ? body.description.trim() : "";
      set.description = trimmed === "" ? null : trimmed.slice(0, MAX_DESCRIPTION_LENGTH);
    }
    if (body.priority !== undefined && body.priority !== null) {
      const priority = parsePriority(body.priority);
      if (priority === null) {
        return NextResponse.json(
          { success: false, error: "priority must be a non-negative integer" },
          { status: 400 }
        );
      }
      set.priority = priority;
    }
    if (Object.keys(set).length === 0) {
      return NextResponse.json(
        { success: false, error: "Nothing to update: provide targetModel, description and/or priority" },
        { status: 400 }
      );
    }

    try {
      await db
        .update(namedRouteTargetsTable)
        .set(set)
        .where(eq(namedRouteTargetsTable.id, targetId));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        return NextResponse.json(
          { success: false, error: "Target already exists for this upstream + model" },
          { status: 409 }
        );
      }
      throw err;
    }
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "named_route_updated",
      targetType: "named_route",
      targetId: routeId,
      ip,
      userAgent,
      details: { name: route.name, change: "target_updated", targetId, after: set },
    });
    return NextResponse.json({ success: true });
  });
});

export const DELETE = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const routeId = Number(params.id);
    const targetId = Number(params.targetId);
    const { route, target } = await findRouteAndTarget(routeId, targetId);
    if (!route) {
      return NextResponse.json({ success: false, error: "Named route not found" }, { status: 404 });
    }
    if (!target) {
      return NextResponse.json({ success: false, error: "Target not found" }, { status: 404 });
    }
    await db.delete(namedRouteTargetsTable).where(eq(namedRouteTargetsTable.id, targetId));
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "named_route_updated",
      targetType: "named_route",
      targetId: routeId,
      ip,
      userAgent,
      details: {
        name: route.name,
        change: "target_deleted",
        targetId,
        upstreamId: target.upstreamId,
        targetModel: target.upstreamModel,
      },
    });
    return NextResponse.json({ success: true });
  });
});
