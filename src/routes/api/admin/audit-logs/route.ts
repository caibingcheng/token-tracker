import { NextRequest, NextResponse } from "next/server";
import { desc, inArray, sql } from "drizzle-orm";
import { db, initDatabase, adminAuditLogsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { parseFilterValues, FilterParamError } from "@/lib/filter-params";

// 只读审计日志分页查询：created_at 倒序，支持按 action 多选过滤（?action=a&action=b）；同时返回库里出现过的 action 列表（供筛选下拉）
export const GET = withAuth(async (request: NextRequest) => {
  const url = new URL(request.url);
  let actionFilters: string[];
  try {
    actionFilters = parseFilterValues(url.searchParams, "action");
  } catch (error) {
    if (error instanceof FilterParamError) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }
    throw error;
  }

  return withSkipCache(async () => {
    await initDatabase();
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("pageSize")) || 50));

    const where =
      actionFilters.length > 0 ? inArray(adminAuditLogsTable.action, actionFilters) : undefined;

    const total = Number(
      (
        await db
          .select({ count: sql<number>`COUNT(*)` })
          .from(adminAuditLogsTable)
          .where(where)
      )[0].count
    );

    const rows = await db
      .select()
      .from(adminAuditLogsTable)
      .where(where)
      .orderBy(desc(adminAuditLogsTable.createdAt))
      .limit(pageSize)
      .offset((page - 1) * pageSize);

    const items = rows.map((row: any) => {
      let details: unknown = null;
      if (row.details != null) {
        try {
          details = JSON.parse(row.details);
        } catch {
          details = null;
        }
      }
      return {
        id: row.id,
        action: row.action,
        actor: row.actor,
        targetType: row.targetType,
        targetId: row.targetId,
        ip: row.ip,
        userAgent: row.userAgent,
        details,
        createdAt: row.createdAt,
      };
    });

    const actions = (
      await db
        .selectDistinct({ action: adminAuditLogsTable.action })
        .from(adminAuditLogsTable)
        .orderBy(adminAuditLogsTable.action)
    )
      .map((row: { action: string | null }) => row.action)
      .filter((action: string | null): action is string => Boolean(action));

    return NextResponse.json({
      success: true,
      data: {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
        actions,
      },
    });
  });
});
