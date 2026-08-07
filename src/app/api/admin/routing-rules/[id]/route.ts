import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, routingRulesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

interface Params {
  params: { id: string };
}

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
