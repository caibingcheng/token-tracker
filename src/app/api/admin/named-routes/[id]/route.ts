import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, namedRoutesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { MAX_INSTRUCTION_LENGTH, validateClassifier } from "@/lib/admin/named-routes";

interface Params {
  params: { id: string };
}

// PATCH：仅允许改 instruction / classifier / enabled（name+protocol 是身份键，改动等价于删旧建新）
export const PATCH = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const rows = await db.select().from(namedRoutesTable).where(eq(namedRoutesTable.id, id));
    const route = rows[0];
    if (!route) {
      return NextResponse.json({ success: false, error: "Named route not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const set: Partial<{
      instruction: string;
      classifierKind: string;
      classifierUpstreamId: number;
      classifierModel: string;
      enabled: number;
    }> = {};

    if (body.instruction !== undefined) {
      if (typeof body.instruction !== "string" || body.instruction.length > MAX_INSTRUCTION_LENGTH) {
        return NextResponse.json(
          { success: false, error: `instruction must be a string (max ${MAX_INSTRUCTION_LENGTH} chars)` },
          { status: 400 }
        );
      }
      set.instruction = body.instruction.trim();
    }

    // 分类器：kind 或指向任一变化时整体重校验（两个字段必须与 kind 自洽）
    if (
      body.classifierKind !== undefined ||
      body.classifierUpstreamId !== undefined ||
      body.classifierModel !== undefined
    ) {
      const classifier = await validateClassifier({
        classifierKind: body.classifierKind ?? "model",
        classifierUpstreamId: body.classifierUpstreamId,
        classifierModel: body.classifierModel,
      });
      if (!classifier.ok) {
        const missingRef =
          classifier.error === "classifierUpstreamId is required" ||
          classifier.error === "classifierModel is required";
        return NextResponse.json(
          {
            success: false,
            error: missingRef
              ? "classifierUpstreamId and classifierModel must be provided together"
              : classifier.error,
          },
          { status: 400 }
        );
      }
      set.classifierKind = classifier.kind;
      set.classifierUpstreamId = classifier.upstreamId;
      set.classifierModel = classifier.model;
    }

    if (body.enabled !== undefined) {
      set.enabled = body.enabled ? 1 : 0;
    }

    if (Object.keys(set).length === 0) {
      return NextResponse.json({ success: false, error: "No fields to update" }, { status: 400 });
    }

    await db.update(namedRoutesTable).set(set).where(eq(namedRoutesTable.id, id));
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "named_route_updated",
      targetType: "named_route",
      targetId: id,
      ip,
      userAgent,
      details: { name: route.name, protocol: route.protocol, changed: Object.keys(set) },
    });
    return NextResponse.json({ success: true });
  });
});

export const DELETE = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const rows = await db.select().from(namedRoutesTable).where(eq(namedRoutesTable.id, id));
    const route = rows[0];
    if (!route) {
      return NextResponse.json({ success: false, error: "Named route not found" }, { status: 404 });
    }
    await db.delete(namedRoutesTable).where(eq(namedRoutesTable.id, id));
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "named_route_deleted",
      targetType: "named_route",
      targetId: id,
      ip,
      userAgent,
      details: { name: route.name, protocol: route.protocol },
    });
    return NextResponse.json({ success: true });
  });
});
