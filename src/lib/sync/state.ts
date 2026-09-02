// B 侧同步状态聚合查询（/api/admin/sync/status 与 Sync tab UI 的数据源）。
// 丢失可观测：cursor / 待推送数 / dropped / 最近成功 / 最近错误 全部暴露，绝不静默。

import { sql } from "drizzle-orm";
import { db, initDatabase, tokenRecords } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { loadSyncConfig, type SyncLastError } from "./config";

const REMOTE_SENTINEL_VK_ID = -1;

export interface SyncStatus {
  configured: boolean;
  targetUrl: string | null;
  hasToken: boolean;
  instance: string;
  uid: string; // 稳定身份键（A 端 TOFU/水位/删除均按 uid）
  epoch: string;
  cursor: number;
  pendingCount: number; // 待推送记录数（游标之后非 -1 哨兵）
  maxRecordId: number; // 本地最大 record id（含 -1 哨兵）
  droppedCount: number;
  boundUid: string | null;
  lastSuccessAt: string | null;
  lastError: SyncLastError | null;
  lastAttemptAt: string | null;
  lastSkippedInvalid: number[] | null; // 最近一次 ack 的部分接受记录 id
}

export async function getSyncStatus(): Promise<SyncStatus> {
  await initDatabase();
  const config = await loadSyncConfig();

  const rows = (await withSkipCache(async () =>
    db
      .select({
        pending: sql<number>`COUNT(CASE WHEN COALESCE(${tokenRecords.virtualKeyId}, 0) != ${REMOTE_SENTINEL_VK_ID} THEN 1 END)`,
        maxId: sql<number>`COALESCE(MAX(${tokenRecords.id}), 0)`,
      })
      .from(tokenRecords)
      .where(sql`${tokenRecords.id} > ${config.cursor}`)
  )) as Array<{ pending: number; maxId: number }>;

  return {
    configured: config.targetUrl !== null && config.hasToken,
    targetUrl: config.targetUrl,
    hasToken: config.hasToken,
    instance: config.instance,
    uid: config.uid,
    epoch: config.epoch,
    cursor: config.cursor,
    pendingCount: Number(rows[0]?.pending ?? 0),
    maxRecordId: Number(rows[0]?.maxId ?? 0),
    droppedCount: config.droppedCount,
    boundUid: config.boundUid,
    lastSuccessAt: config.lastSuccessAt,
    lastError: config.lastError,
    lastAttemptAt: config.lastAttemptAt,
    lastSkippedInvalid: config.lastSkippedInvalid,
  };
}