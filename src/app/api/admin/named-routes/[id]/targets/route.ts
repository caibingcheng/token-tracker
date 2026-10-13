import { NextRequest, NextResponse } from "next/server";
import { and, eq, isNull } from "drizzle-orm";
import { db, initDatabase, namedRouteTargetsTable, namedRoutesTable, upstreamsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { isProtocol } from "@/lib/gateway/model-router";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { MAX_DESCRIPTION_LENGTH, parsePriority } from "@/lib/admin/named-routes";

interface Params {
  params: { id: string };
}

async function findNamedRouteById(id: number) {
  const rows = await db.select().from(namedRoutesTable).where(eq(namedRoutesTable.id, id));
  return rows[0] || null;
}

// POST：给命名路由追加一个目标（upstream + 真实模型 + 特性描述 + 优先级）
export const POST = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const routeId = Number(params.id);
    const route = await findNamedRouteById(routeId);
    if (!route) {
      return NextResponse.json({ success: false, error: "Named route not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    // upstreamId 可省略/null = 无 provider 目标：targetModel 按路由解析（命名路由嵌套 > 自动路由候选池）
    const isAuto = body.upstreamId === undefined || body.upstreamId === null;
    const upstreamId = isAuto ? null : Number(body.upstreamId);
    const targetModel = typeof body.targetModel === "string" ? body.targetModel.trim() : "";
    const priority = parsePriority(body.priority);
    const description =
      typeof body.description === "string" && body.description.trim() !== ""
        ? body.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
        : null;

    if (!targetModel) {
      return NextResponse.json(
        { success: false, error: "Missing required field: targetModel" },
        { status: 400 }
      );
    }
    if (!isAuto && (!Number.isInteger(upstreamId) || (upstreamId as number) <= 0)) {
      return NextResponse.json(
        { success: false, error: "upstreamId must be a positive integer (or omit for auto-routing target)" },
        { status: 400 }
      );
    }
    if (priority === null) {
      return NextResponse.json(
        { success: false, error: "priority must be a non-negative integer" },
        { status: 400 }
      );
    }

    if (!isAuto) {
      const upstream = (
        await db.select().from(upstreamsTable).where(eq(upstreamsTable.id, upstreamId as number))
      )[0];
      if (!upstream) {
        return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 400 });
      }
      // 目标协议必须与路由协议一致：转发时按请求协议改写 body/path，错配必失败
      const routeProtocol = isProtocol(route.protocol) ? route.protocol : "openai";
      if (upstream.protocol !== routeProtocol) {
        return NextResponse.json(
          {
            success: false,
            error: `Protocol mismatch: target upstream "${upstream.name}" is ${upstream.protocol}, named route is ${routeProtocol}`,
          },
          { status: 400 }
        );
      }
    } else {
      // auto 目标查重：UNIQUE 索引对 NULL upstream_id 不去重（NULL ≠ NULL），走应用层 409
      const dup = await db
        .select({ id: namedRouteTargetsTable.id })
        .from(namedRouteTargetsTable)
        .where(
          and(
            eq(namedRouteTargetsTable.namedRouteId, routeId),
            eq(namedRouteTargetsTable.upstreamModel, targetModel),
            isNull(namedRouteTargetsTable.upstreamId)
          )
        );
      if (dup.length > 0) {
        return NextResponse.json(
          {
            success: false,
            error: `Auto target already exists for model "${targetModel}" on this named route`,
          },
          { status: 409 }
        );
      }
    }

    try {
      const result = await db
        .insert(namedRouteTargetsTable)
        .values({ namedRouteId: routeId, upstreamId, upstreamModel: targetModel, description, priority })
        .returning();
      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "named_route_updated",
        targetType: "named_route",
        targetId: routeId,
        ip,
        userAgent,
        details: { name: route.name, change: "target_added", upstreamId, targetModel, description, priority },
      });
      return NextResponse.json({ success: true, data: result[0] }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        return NextResponse.json(
          {
            success: false,
            error: `Target already exists for this named route (upstream ${upstreamId}, model ${targetModel})`,
          },
          { status: 409 }
        );
      }
      console.error("Create named route target error:", err);
      return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
  });
});
