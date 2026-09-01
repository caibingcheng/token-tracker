// A 侧 ingest 事务写入：TOFU 绑定检查 + 去重 + 写入 + 水位推进（单事务原子）。
// better-sqlite3 事务回调为同步执行，内部禁止 await。
// 同实例并发（同名误配两个进程）：SQLite 单写者串行化，后到事务读到已推进水位，
// 重复不可能（最坏整批被 skip）。

import { eq, and, sql } from "drizzle-orm";
import { db, initDatabase, tokenRecords, ingestTokensTable, syncInstancesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import type { ValidatedIngestPayload, IngestRecordPayload } from "./validate";

// 序列化远程来源的 provider/agent：带 instance 前缀，与本机命名空间隔离
export function remotePrefixedName(instance: string, name: string): string {
  return `remote/${instance}/${name}`;
}

export interface IngestBatchResult {
  status: "ok" | "instance_mismatch" | "token_disabled";
  received: number;
  skipped: number; // 批内跳过（含水位去重与 invalid）
  skippedInvalid: number[]; // 校验失败（batch 内无法写入）的记录 id
  watermark: number;
  boundInstance: string;
}

// 单条记录的写库映射（virtual_key_id 置哨兵 -1：远程来源标记 + 防转发级联）
export function toStoredRecord(
  instance: string,
  record: IngestRecordPayload
): Record<string, unknown> {
  return {
    model: record.model,
    provider: remotePrefixedName(instance, record.provider),
    agent: remotePrefixedName(instance, record.agent),
    inputTokens: record.inputTokens,
    outputTokens: record.outputTokens,
    cacheRead: record.cacheRead,
    cacheWrite: record.cacheWrite,
    status: record.status ?? null,
    latencyMs: record.latencyMs ?? null,
    ttftMs: record.ttftMs ?? null,
    virtualKeyId: -1,
    userAgent: record.userAgent ?? null,
    requestModel: record.requestModel ?? null,
    createdAt: record.createdAt,
  };
}

// 事务写入入口：token 信息（含事务前读取的 boundInstance）与 payload
export async function ingestRecords(
  payload: ValidatedIngestPayload,
  token: { id: number; boundInstance: string | null }
): Promise<IngestBatchResult> {
  await initDatabase();
  return withSkipCache(() =>
    db.transaction((tx: any) => {
      const nowIso = new Date().toISOString();

      // TOFU 绑定检查（事务内重新读取，防并发竞态）
      const tokenRow = tx
        .select()
        .from(ingestTokensTable)
        .where(eq(ingestTokensTable.id, token.id))
        .get();
      if (!tokenRow || tokenRow.enabled !== 1) {
        return { status: "token_disabled", received: 0, skipped: payload.records.length, skippedInvalid: [], watermark: 0, boundInstance: tokenRow?.boundInstance ?? token.boundInstance ?? "" };
      }
      let boundInstance = tokenRow.boundInstance ?? null;
      if (boundInstance === null) {
        tx.update(ingestTokensTable)
          .set({ boundInstance: payload.instance, lastUsedAt: nowIso })
          .where(eq(ingestTokensTable.id, token.id))
          .run();
        boundInstance = payload.instance;
      } else if (boundInstance !== payload.instance) {
        return { status: "instance_mismatch", received: 0, skipped: payload.records.length, skippedInvalid: [], watermark: 0, boundInstance };
      } else {
        tx.update(ingestTokensTable)
          .set({ lastUsedAt: nowIso })
          .where(eq(ingestTokensTable.id, token.id))
          .run();
      }

      // 水位行：epoch 不一致 → 重置为 0（B 重建 DB 场景）
      const instanceRow = tx
        .select()
        .from(syncInstancesTable)
        .where(eq(syncInstancesTable.instance, payload.instance))
        .get();
      let watermark = 0;
      if (instanceRow && instanceRow.epoch === payload.epoch) {
        watermark = Number(instanceRow.lastRecordId) || 0;
      } else {
        tx.insert(syncInstancesTable)
          .values({ instance: payload.instance, epoch: payload.epoch, lastRecordId: 0, updatedAt: nowIso })
          .onConflictDoUpdate({
            target: syncInstancesTable.instance,
            set: { epoch: payload.epoch, lastRecordId: 0, updatedAt: nowIso },
          })
          .run();
      }

      // 去重：sourceRecordId <= 水位 的记录跳过
      const toWrite: Array<Record<string, unknown>> = [];
      let maxSourceRecordId = watermark;
      for (const record of payload.records) {
        if (record.sourceRecordId <= watermark) continue;
        toWrite.push(toStoredRecord(payload.instance, record));
        if (record.sourceRecordId > maxSourceRecordId) {
          maxSourceRecordId = record.sourceRecordId;
        }
      }

      if (toWrite.length > 0) {
        tx.insert(tokenRecords).values(toWrite).run();
      }

      // 条件推进水位（只升不降）
      tx.update(syncInstancesTable)
        .set({ lastRecordId: maxSourceRecordId, updatedAt: nowIso })
        .where(
          and(
            eq(syncInstancesTable.instance, payload.instance),
            eq(syncInstancesTable.epoch, payload.epoch),
            sql`${syncInstancesTable.lastRecordId} < ${maxSourceRecordId}`
          )
        )
        .run();

      return {
        status: "ok",
        received: toWrite.length,
        // skipped 语义 = 批内未写入总条数（水位去重 + 校验失败均计入）
        skipped: payload.records.length + payload.skippedInvalid.length - toWrite.length,
        skippedInvalid: payload.skippedInvalid,
        watermark: maxSourceRecordId,
        boundInstance: boundInstance ?? "",
      };
    })
  );
}