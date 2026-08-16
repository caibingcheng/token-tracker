import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, virtualKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

interface Params {
  params: { id: string };
}

// 配额字段校验：undefined → 不传；null/0 → NULL（清除限制）；非负整数 → 值；其余 → 非法
function parseQuotaField(
  body: Record<string, unknown>,
  field: string
): { ok: true; value?: number | null } | { ok: false } {
  if (body[field] === undefined) return { ok: true };
  const value = body[field];
  if (value === null) return { ok: true, value: null };
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { ok: true, value: value === 0 ? null : value };
  }
  return { ok: false };
}

export const PATCH = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const row = (
      await db.select().from(virtualKeysTable).where(eq(virtualKeysTable.id, id))
    )[0];
    if (!row) {
      return NextResponse.json({ success: false, error: "Virtual key not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const values: Record<string, unknown> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json({ success: false, error: "name cannot be empty" }, { status: 400 });
      }
      values.name = name;
    }
    if (typeof body.comment === "string") {
      values.comment = body.comment.trim() || null;
    }
    if (body.enabledModels !== undefined) {
      if (!Array.isArray(body.enabledModels)) {
        return NextResponse.json(
          { success: false, error: "enabledModels must be an array of strings" },
          { status: 400 }
        );
      }
      const patterns = body.enabledModels.filter(
        (m): m is string => typeof m === "string" && m.trim().length > 0
      );
      if (patterns.length === 0) {
        return NextResponse.json(
          { success: false, error: "enabledModels must be a non-empty array" },
          { status: 400 }
        );
      }
      values.enabledModels = JSON.stringify(patterns);
    }
    if (body.enabled !== undefined) {
      values.enabled = body.enabled ? 1 : 0;
    }
    for (const field of ["maxRpm", "maxTpm", "maxDailyTokens", "maxMonthlyTokens"] as const) {
      const parsed = parseQuotaField(body, field);
      if (!parsed.ok) {
        return NextResponse.json(
          { success: false, error: `${field} must be a non-negative integer` },
          { status: 400 }
        );
      }
      if (parsed.value !== undefined) values[field] = parsed.value;
    }
    if (Object.keys(values).length === 0) {
      return NextResponse.json({ success: false, error: "No fields to update" }, { status: 400 });
    }

    try {
      await db.update(virtualKeysTable).set(values).where(eq(virtualKeysTable.id, id));
      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "virtual_key_updated",
        targetType: "virtual_key",
        targetId: id,
        ip,
        userAgent,
        details: { changed: Object.keys(values) },
      });
      return NextResponse.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        return NextResponse.json({ success: false, error: "Virtual key name already exists" }, { status: 409 });
      }
      console.error("Update virtual key error:", err);
      return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
  });
});

export const DELETE = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const row = (
      await db.select().from(virtualKeysTable).where(eq(virtualKeysTable.id, id))
    )[0];
    if (!row) {
      return NextResponse.json({ success: false, error: "Virtual key not found" }, { status: 404 });
    }
    await db.delete(virtualKeysTable).where(eq(virtualKeysTable.id, id));
    // 可选联动：同时隐藏其历史数据（追加进 hidden_sources，不自动隐藏）
    if (request.nextUrl.searchParams.get("hideHistory") === "1") {
      const { loadHiddenSources, setHiddenSourcesSetting } = await import(
        "@/lib/auth/settings"
      );
      const cfg = await loadHiddenSources();
      if (!cfg.virtualKeys.includes(row.name)) {
        await setHiddenSourcesSetting({
          ...cfg,
          virtualKeys: [...cfg.virtualKeys, row.name],
        });
      }
    }
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "virtual_key_deleted",
      targetType: "virtual_key",
      targetId: id,
      ip,
      userAgent,
      details: { name: row.name },
    });
    return NextResponse.json({ success: true });
  });
});
