import { NextRequest, NextResponse } from "next/server";
import { sql } from "drizzle-orm";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import { db, initDatabase, syncInstancesTable } from "@/lib/db";
import { INSTANCE_NAME_RE } from "@/lib/ingest/validate";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

// 删除水位：同名新实例可干净 TOFU（删除行后绑定关系由 ingest token 保留，
// token 需要单独 unbind 才是真正干净的重置）
export const DELETE = withAuth(
  async (request: NextRequest, ctx: { params: Record<string, string> }) => {
    return withSkipCache(async () => {
      const instance = ctx.params.instance ?? "";
      if (!INSTANCE_NAME_RE.test(instance)) {
        return NextResponse.json(
          { success: false, error: "Invalid instance name" },
          { status: 400 }
        );
      }
      await initDatabase();
      const result = await db
        .delete(syncInstancesTable)
        .where(sql`${syncInstancesTable.instance} = ${instance}`);
      if (Number(result?.changes ?? 0) === 0) {
        return NextResponse.json(
          { success: false, error: "Sync instance not found" },
          { status: 404 }
        );
      }

      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "sync_instance_deleted",
        targetType: "sync",
        ip,
        userAgent,
        details: { instance },
      });

      return NextResponse.json({ success: true });
    });
  }
);