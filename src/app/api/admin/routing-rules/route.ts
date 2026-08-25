import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db, initDatabase, routingRulesTable, upstreamsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { isProtocol, VALID_PROTOCOLS } from "@/lib/gateway/model-router";
import type { Protocol } from "@/lib/gateway/model-router";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

interface RuleWithUpstream {
  id: number;
  name: string;
  protocol: Protocol;
  upstreamId: number;
  upstreamName: string;
  upstreamProtocol: Protocol;
  targetModel: string;
  priority: number;
  createdAt: string;
}

// 查询全部规则（join upstream 供 UI 展示 provider）
export const GET = withAuth(async () => {
  return withSkipCache(async () => {
    await initDatabase();
    const rows = await db
      .select({
        rule: routingRulesTable,
        upstream: upstreamsTable,
      })
      .from(routingRulesTable)
      .leftJoin(upstreamsTable, eq(routingRulesTable.upstreamId, upstreamsTable.id))
      .orderBy(
        routingRulesTable.name,
        routingRulesTable.protocol,
        routingRulesTable.priority,
        routingRulesTable.id
      );

    const data: RuleWithUpstream[] = rows.map((row: any) => ({
      id: row.rule.id,
      name: row.rule.name,
      protocol: isProtocol(row.rule.protocol) ? row.rule.protocol : "openai",
      upstreamId: row.rule.upstreamId,
      upstreamName: row.upstream?.name ?? "(deleted)",
      upstreamProtocol: row.upstream && isProtocol(row.upstream.protocol) ? row.upstream.protocol : "openai",
      targetModel: row.rule.targetModel,
      priority: row.rule.priority,
      createdAt: row.rule.createdAt,
    }));

    return NextResponse.json({ success: true, data });
  });
});

export const POST = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    await initDatabase();
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const protocol = typeof body.protocol === "string" ? body.protocol : "";
    const upstreamId = Number(body.upstreamId);
    const targetModel = typeof body.targetModel === "string" ? body.targetModel.trim() : "";

    // priority 可选：非负整数（默认 0），小者先尝试
    let priority = 0;
    if (body.priority !== undefined && body.priority !== null) {
      if (typeof body.priority !== "number" || !Number.isInteger(body.priority) || body.priority < 0) {
        return NextResponse.json(
          { success: false, error: "priority must be a non-negative integer" },
          { status: 400 }
        );
      }
      priority = body.priority;
    }

    if (!name || !protocol || !upstreamId || !targetModel) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: name, protocol, upstreamId, targetModel" },
        { status: 400 }
      );
    }
    if (!isProtocol(protocol)) {
      return NextResponse.json(
        { success: false, error: `Invalid protocol, must be one of: ${VALID_PROTOCOLS.join(", ")}` },
        { status: 400 }
      );
    }

    const upstreams = await db.select().from(upstreamsTable).where(inArray(upstreamsTable.id, [upstreamId]));
    const upstream = upstreams[0];
    if (!upstream) {
      return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 400 });
    }
    // 手动路由 protocol 必须与目标 upstream protocol 一致，避免运行时协议错配
    if (upstream.protocol !== protocol) {
      return NextResponse.json(
        {
          success: false,
          error: `Protocol mismatch: rule protocol "${protocol}" does not match upstream "${upstream.name}" protocol "${upstream.protocol}"`,
        },
        { status: 400 }
      );
    }

    try {
      const result = await db
        .insert(routingRulesTable)
        .values({
          name,
          protocol,
          upstreamId,
          targetModel,
          priority,
        })
        .returning();
      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "routing_rule_created",
        targetType: "routing_rule",
        targetId: result[0].id,
        ip,
        userAgent,
        details: { name, protocol, upstreamId, targetModel, priority },
      });
      return NextResponse.json({ success: true, data: result[0] }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        return NextResponse.json(
          {
            success: false,
            error: `Routing rule already exists for "${name}" (${protocol}, upstream ${upstreamId})`,
          },
          { status: 409 }
        );
      }
      console.error("Create routing rule error:", err);
      return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
  });
});
