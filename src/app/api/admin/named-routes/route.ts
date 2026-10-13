import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import {
  db,
  initDatabase,
  namedRouteTargetsTable,
  namedRoutesTable,
  upstreamsTable,
} from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { isProtocol, VALID_PROTOCOLS } from "@/lib/gateway/model-router";
import type { Protocol } from "@/lib/gateway/model-router";
import type { ClassifierKind } from "@/lib/gateway/classifier/types";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import {
  MAX_DESCRIPTION_LENGTH,
  MAX_INSTRUCTION_LENGTH,
  parsePriority,
  validateClassifier,
} from "@/lib/admin/named-routes";

export interface NamedRouteTargetRow {
  id: number;
  upstreamId: number;
  upstreamName: string;
  upstreamProtocol: Protocol;
  targetModel: string;
  description: string | null;
  priority: number;
}

export interface NamedRouteRow {
  id: number;
  name: string;
  protocol: Protocol;
  instruction: string;
  classifierUpstreamId: number;
  classifierUpstreamName: string;
  classifierModel: string;
  classifierKind: ClassifierKind;
  enabled: boolean;
  targets: NamedRouteTargetRow[];
  createdAt: string;
}

// GET：全部命名路由 + 各自目标池（join upstream 供 UI 展示）
export const GET = withAuth(async () => {
  return withSkipCache(async () => {
    await initDatabase();
    const rows = await db
      .select({ route: namedRoutesTable, upstream: upstreamsTable })
      .from(namedRoutesTable)
      .leftJoin(upstreamsTable, eq(namedRoutesTable.classifierUpstreamId, upstreamsTable.id))
      .orderBy(namedRoutesTable.name, namedRoutesTable.protocol);
    const targetRows = await db
      .select({ target: namedRouteTargetsTable, upstream: upstreamsTable })
      .from(namedRouteTargetsTable)
      .leftJoin(upstreamsTable, eq(namedRouteTargetsTable.upstreamId, upstreamsTable.id));

    const targetsByRoute = new Map<number, NamedRouteTargetRow[]>();
    for (const row of targetRows as any[]) {
      const list = targetsByRoute.get(row.target.namedRouteId) ?? [];
      list.push({
        id: row.target.id,
        upstreamId: row.target.upstreamId,
        upstreamName: row.upstream?.name ?? "(deleted)",
        upstreamProtocol:
          row.upstream && isProtocol(row.upstream.protocol) ? row.upstream.protocol : "openai",
        targetModel: row.target.upstreamModel,
        description: row.target.description ?? null,
        priority: row.target.priority ?? 0,
      });
      targetsByRoute.set(row.target.namedRouteId, list);
    }
    Array.from(targetsByRoute.values()).forEach((list) => {
      list.sort((a, b) => a.priority - b.priority || a.id - b.id);
    });

    const data: NamedRouteRow[] = rows.map((row: any) => ({
      id: row.route.id,
      name: row.route.name,
      protocol: isProtocol(row.route.protocol) ? row.route.protocol : "openai",
      instruction: row.route.instruction ?? "",
      classifierUpstreamId: row.route.classifierUpstreamId ?? 0,
      classifierUpstreamName: row.upstream?.name ?? "",
      classifierModel: row.route.classifierModel ?? "",
      classifierKind: row.route.classifierKind === "model" ? "model" : "priority",
      enabled: row.route.enabled === 1,
      targets: targetsByRoute.get(row.route.id) ?? [],
      createdAt: row.route.createdAt,
    }));
    return NextResponse.json({ success: true, data });
  });
});

// POST：创建命名路由，可一次性附上首个目标（UI 的「新建路由」一步到位）
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
    const instruction = typeof body.instruction === "string" ? body.instruction.trim() : "";

    if (!name || name.length > 256) {
      return NextResponse.json({ success: false, error: "name is required (max 256 chars)" }, { status: 400 });
    }
    if (!isProtocol(protocol)) {
      return NextResponse.json(
        { success: false, error: `Invalid protocol, must be one of: ${VALID_PROTOCOLS.join(", ")}` },
        { status: 400 }
      );
    }
    if (instruction.length > MAX_INSTRUCTION_LENGTH) {
      return NextResponse.json(
        { success: false, error: `instruction too long (max ${MAX_INSTRUCTION_LENGTH} chars)` },
        { status: 400 }
      );
    }

    const classifier = await validateClassifier({
      classifierKind: body.classifierKind,
      classifierUpstreamId: body.classifierUpstreamId,
      classifierModel: body.classifierModel,
    });
    if (!classifier.ok) {
      return NextResponse.json({ success: false, error: classifier.error }, { status: 400 });
    }

    // 可选首目标：与目标池写入同口径校验（协议必须与路由一致）
    let target: { upstreamId: number; targetModel: string; description: string | null; priority: number } | null =
      null;
    if (body.target !== undefined) {
      const raw = body.target as Record<string, unknown>;
      const upstreamId = Number(raw?.upstreamId);
      const targetModel = typeof raw?.targetModel === "string" ? raw.targetModel.trim() : "";
      const priority = parsePriority(raw?.priority);
      if (!Number.isInteger(upstreamId) || upstreamId <= 0 || !targetModel) {
        return NextResponse.json(
          { success: false, error: "target requires upstreamId and targetModel" },
          { status: 400 }
        );
      }
      if (priority === null) {
        return NextResponse.json(
          { success: false, error: "priority must be a non-negative integer" },
          { status: 400 }
        );
      }
      const upstream = (
        await db.select().from(upstreamsTable).where(eq(upstreamsTable.id, upstreamId))
      )[0];
      if (!upstream) {
        return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 400 });
      }
      if (upstream.protocol !== protocol) {
        return NextResponse.json(
          {
            success: false,
            error: `Protocol mismatch: target upstream "${upstream.name}" is ${upstream.protocol}, named route is ${protocol}`,
          },
          { status: 400 }
        );
      }
      target = {
        upstreamId,
        targetModel,
        description:
          typeof raw?.description === "string" && raw.description.trim() !== ""
            ? raw.description.trim().slice(0, MAX_DESCRIPTION_LENGTH)
            : null,
        priority,
      };
    }

    const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    try {
      // better-sqlite3 事务回调为同步执行（禁止 await）：校验已全部在上方完成
      const created = db.transaction((tx: any) => {
        const route = tx
          .insert(namedRoutesTable)
          .values({
            name,
            protocol,
            instruction,
            classifierUpstreamId: classifier.upstreamId,
            classifierModel: classifier.model,
            classifierKind: classifier.kind,
            enabled: enabled ? 1 : 0,
          })
          .returning()
          .get();
        if (target) {
          tx.insert(namedRouteTargetsTable)
            .values({
              namedRouteId: route.id,
              upstreamId: target.upstreamId,
              upstreamModel: target.targetModel,
              description: target.description,
              priority: target.priority,
            })
            .run();
        }
        return route;
      });

      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "named_route_created",
        targetType: "named_route",
        targetId: created.id,
        ip,
        userAgent,
        details: {
          name,
          protocol,
          classifierKind: classifier.kind,
          classifierUpstreamId: classifier.upstreamId,
          classifierModel: classifier.model,
          enabled,
          target,
        },
      });
      return NextResponse.json({ success: true, data: created }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        return NextResponse.json(
          { success: false, error: `Named route already exists for "${name}" (${protocol})` },
          { status: 409 }
        );
      }
      console.error("Create named route error:", err);
      return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
  });
});
