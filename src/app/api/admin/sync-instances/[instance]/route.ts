import { NextRequest, NextResponse } from "next/server";
import { and, eq, sql } from "drizzle-orm";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import { db, initDatabase, syncInstancesTable, tokenRecords } from "@/lib/db";
import { INSTANCE_NAME_RE } from "@/lib/ingest/validate";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { invalidateStatusCache } from "@/lib/status-query";

// 删除水位：同名新实例可干净 TOFU（删除行后绑定关系由 ingest token 保留，
// token 需要单独 unbind 才是真正干净的重置）。
// ?deleteRecords=1 时级联删除该实例已推送的历史记录（provider LIKE 'remote/{instance}/%'
// AND virtual_key_id = -1 哨兵双保险防误删本地记录）；默认只删水位行，记录保留。
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
      const deleteRecords = request.nextUrl.searchParams.get("deleteRecords") === "1";

      // 先查水位行存在性：不存在 → 404，不动任何记录
      const existing = await db
        .select({ instance: syncInstancesTable.instance })
        .from(syncInstancesTable)
        .where(eq(syncInstancesTable.instance, instance));
      if (existing.length === 0) {
        return NextResponse.json(
          { success: false, error: "Sync instance not found" },
          { status: 404 }
        );
      }

      let deletedRecords = 0;
      if (deleteRecords) {
        // instance 名受 INSTANCE_NAME_RE（[a-z0-9-]）约束，LIKE 无通配符注入风险；
        // virtual_key_id = -1 哨兵双保险：本地记录（vk != -1）即使同前缀也不误删
        const del = await db
          .delete(tokenRecords)
          .where(
            and(
              sql`${tokenRecords.provider} LIKE ${`remote/${instance}/%`}`,
              eq(tokenRecords.virtualKeyId, -1)
            )
          );
        deletedRecords = Number(del?.changes ?? 0);
        // 级联删除影响公开 Status 响应级缓存，主动失效
        invalidateStatusCache();
      }

      await db
        .delete(syncInstancesTable)
        .where(eq(syncInstancesTable.instance, instance));

      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "sync_instance_deleted",
        targetType: "sync",
        ip,
        userAgent,
        details: { instance, deleteRecords, deletedRecords },
      });

      return NextResponse.json({ success: true, data: { deletedRecords } });
    });
  }
);