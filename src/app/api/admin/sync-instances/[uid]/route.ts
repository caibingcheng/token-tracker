import { NextRequest, NextResponse } from "next/server";
import { and, eq, or, sql } from "drizzle-orm";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import { db, initDatabase, syncInstancesTable, tokenRecords } from "@/lib/db";
import { INSTANCE_UID_RE } from "@/lib/ingest/validate";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { invalidateStatusCache } from "@/lib/status-query";

// 删除水位：同 uid 新实例可干净 TOFU（删除行后绑定关系由 ingest token 保留，
// token 需要单独 unbind 才是真正干净的重置）。
// ?deleteRecords=1 时级联删除该实例已推送的历史记录：remote_instance_uid = uid
// 等值匹配 + virtual_key_id = -1 哨兵双保险防误删本地记录；
// OR 上旧行（uid 列迁移前写入、保持 NULL）的 provider LIKE 'remote/{instance}/%'
// 前缀兼容兜底（instance 名受 INSTANCE_NAME_RE 约束，LIKE 无通配符注入风险）。
// 默认只删水位行，记录保留。
export const DELETE = withAuth(
  async (request: NextRequest, ctx: { params: Record<string, string> }) => {
    return withSkipCache(async () => {
      const uid = ctx.params.uid ?? "";
      if (!INSTANCE_UID_RE.test(uid)) {
        return NextResponse.json(
          { success: false, error: "Invalid instance uid" },
          { status: 400 }
        );
      }
      await initDatabase();
      const deleteRecords = request.nextUrl.searchParams.get("deleteRecords") === "1";

      // 先查水位行存在性：不存在 → 404，不动任何记录
      const existing = await db
        .select({ uid: syncInstancesTable.uid, instanceName: syncInstancesTable.instanceName })
        .from(syncInstancesTable)
        .where(eq(syncInstancesTable.uid, uid));
      if (existing.length === 0) {
        return NextResponse.json(
          { success: false, error: "Sync instance not found" },
          { status: 404 }
        );
      }
      const instanceName = existing[0].instanceName ?? null;

      let deletedRecords = 0;
      if (deleteRecords) {
        // uid 等值 + 哨兵双保险；LIKE 前缀条件仅作为 uid NULL 旧行的兼容兜底（OR 关系）
        const del = await db
          .delete(tokenRecords)
          .where(
            or(
              and(
                eq(tokenRecords.remoteInstanceUid, uid),
                eq(tokenRecords.virtualKeyId, -1)
              ),
              instanceName
                ? and(
                    sql`${tokenRecords.provider} LIKE ${`remote/${instanceName}/%`}`,
                    eq(tokenRecords.virtualKeyId, -1),
                    sql`${tokenRecords.remoteInstanceUid} IS NULL`
                  )
                : undefined
            )
          );
        deletedRecords = Number(del?.changes ?? 0);
        // 级联删除影响公开 Status 响应级缓存，主动失效
        invalidateStatusCache();
      }

      await db
        .delete(syncInstancesTable)
        .where(eq(syncInstancesTable.uid, uid));

      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "sync_instance_deleted",
        targetType: "sync",
        ip,
        userAgent,
        details: { uid, instanceName, deleteRecords, deletedRecords },
      });

      return NextResponse.json({ success: true, data: { deletedRecords } });
    });
  }
);