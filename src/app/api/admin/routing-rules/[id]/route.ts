import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, routingRulesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

interface Params {
  params: { id: string };
}

export const PATCH = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const rows = await db.select().from(routingRulesTable).where(eq(routingRulesTable.id, id));
    const rule = rows[0];
    if (!rule) {
      return NextResponse.json({ success: false, error: "Routing rule not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    // 仅允许编辑 priority / targetModel（upstream 不允许改：改动等价于删旧建新）
    const set: Partial<{ priority: number; targetModel: string }> = {};
    if (body.targetModel !== undefined) {
      const targetModel = typeof body.targetModel === "string" ? body.targetModel.trim() : "";
      if (!targetModel) {
        return NextResponse.json(
          { success: false, error: "targetModel must be a non-empty string" },
          { status: 400 }
        );
      }
      set.targetModel = targetModel;
    }
    if (body.priority !== undefined && body.priority !== null) {
      if (typeof body.priority !== "number" || !Number.isInteger(body.priority) || body.priority < 0) {
        return NextResponse.json(
          { success: false, error: "priority must be a non-negative integer" },
          { status: 400 }
        );
      }
      set.priority = body.priority;
    }
    if (Object.keys(set).length === 0) {
      return NextResponse.json(
        { success: false, error: "Nothing to update: provide targetModel and/or priority" },
        { status: 400 }
      );
    }

    await db.update(routingRulesTable).set(set).where(eq(routingRulesTable.id, id));
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "routing_rule_updated",
      targetType: "routing_rule",
      targetId: id,
      ip,
      userAgent,
      details: {
        name: rule.name,
        protocol: rule.protocol,
        upstreamId: rule.upstreamId,
        before: { targetModel: rule.targetModel, priority: rule.priority },
        after: set,
      },
    });
    return NextResponse.json({ success: true });
  });
});

export const DELETE = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const rows = await db.select().from(routingRulesTable).where(eq(routingRulesTable.id, id));
    const rule = rows[0];
    if (!rule) {
      return NextResponse.json({ success: false, error: "Routing rule not found" }, { status: 404 });
    }
    await db.delete(routingRulesTable).where(eq(routingRulesTable.id, id));
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "routing_rule_deleted",
      targetType: "routing_rule",
      targetId: id,
      ip,
      userAgent,
      details: { name: rule.name, protocol: rule.protocol, upstreamId: rule.upstreamId, targetModel: rule.targetModel },
    });
    return NextResponse.json({ success: true });
  });
});
