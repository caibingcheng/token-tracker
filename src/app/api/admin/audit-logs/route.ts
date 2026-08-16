import { NextRequest, NextResponse } from "next/server";
import { desc, sql } from "drizzle-orm";
import { db, initDatabase, adminAuditLogsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";

// 只读审计日志分页查询：created_at 倒序，支持按 action 过滤
export const GET = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    await initDatabase();
    const url = new URL(request.url);
    const page = Math.max(1, Number(url.searchParams.get("page")) || 1);
    const pageSize = Math.min(200, Math.max(1, Number(url.searchParams.get("pageSize")) || 50));
    const action = url.searchParams.get("action")?.trim() || null;

    const where = action ? sql`${adminAuditLogsTable.action} = ${action}` : undefined;

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

    return NextResponse.json({
      success: true,
      data: {
        items,
        total,
        page,
        pageSize,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  });
});
