import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, namedRoutesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { MAX_INSTRUCTION_LENGTH, MAX_NAME_LENGTH, validateClassifier } from "@/lib/admin/named-routes";

interface Params {
  params: Promise<{ id: string }>;
}

// PATCH：允许改 name / instruction / classifier / enabled（name 为全局 UNIQUE 身份键，改名撞名按冲突返回 409）
export const PATCH = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params; // params 为 Promise（Next 15+ 动态路由）
  const paramsResolved = await params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(paramsResolved.id);
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
      name: string;
      instruction: string;
      classifierKind: string;
      classifierUpstreamId: number;
      classifierModel: string;
      enabled: number;
    }> = {};

    let nameUnchanged = false;

    if (body.name !== undefined) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name || name.length > MAX_NAME_LENGTH) {
        return NextResponse.json(
          { success: false, error: `name is required (max ${MAX_NAME_LENGTH} chars)` },
          { status: 400 }
        );
      }
      if (name !== route.name) set.name = name;
      else nameUnchanged = true;
    }

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
      // 仅提交与当前值相同的 name：合法 no-op，不写库也不记审计（区别于无有效字段）
      if (nameUnchanged) return NextResponse.json({ success: true });
      return NextResponse.json({ success: false, error: "No fields to update" }, { status: 400 });
    }

    try {
      await db.update(namedRoutesTable).set(set).where(eq(namedRoutesTable.id, id));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        return NextResponse.json(
          { success: false, error: `Named route already exists for "${set.name}"` },
          { status: 409 }
        );
      }
      console.error("Update named route error:", err);
      return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "named_route_updated",
      targetType: "named_route",
      targetId: id,
      ip,
      userAgent,
      details: {
        name: route.name,
        changed: Object.keys(set),
        ...(set.name ? { newName: set.name } : {}),
      },
    });
    return NextResponse.json({ success: true });
  });
});

export const DELETE = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params; // params 为 Promise（Next 15+ 动态路由）
  const paramsResolved = await params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(paramsResolved.id);
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
      details: { name: route.name },
    });
    return NextResponse.json({ success: true });
  });
});
