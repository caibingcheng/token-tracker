// B 侧推送 worker：持久化游标队列 + 批量推送。
// - 模块级单例 + in-flight 互斥锁：同一时刻只有一个推送循环
// - 严格串行：「拉取（id 升序，跳过 virtual_key_id=-1 的哨兵记录）→ 推送 → ack → 推进游标」
// - 游标按原始扫描（含被跳过的 -1 记录）的最大 id 推进，避免停在 -1 记录前反复空扫
// - 未配置（无 target_url/token）时完全不启动，单机使用零开销
// - 单进程假设：一个 B = 一个 Node 进程连一个 SQLite，不支持同库多进程

import { and, gt, sql } from "drizzle-orm";
import { db, initDatabase, tokenRecords } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import type { Dispatcher } from "undici";
import {
  loadSyncConfig,
  getSyncToken,
  setSyncCursor,
  incrementDroppedCount,
  setSyncBoundInstance,
  setSyncLastSuccessAt,
  setSyncLastError,
  setSyncLastAttemptAt,
  type SyncLastError,
} from "./config";
import { recordAuditLog } from "@/lib/admin/audit";

export const BATCH_SIZE = 200;
export const FETCH_TIMEOUT_MS = 10_000;
export const RETRY_INTERVAL_MS = 60_000;
export const MAX_BATCH_REJECTED_RETRIES = 50;
export const BASE_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 5 * 60_000;

const REMOTE_SENTINEL_VK_ID = -1; // ingest 写入的哨兵值：本机不向外转发

export interface SyncRecordRow {
  id: number;
  model: string;
  provider: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  status: string | null;
  latencyMs: number | null;
  ttftMs: number | null;
  requestModel: string | null;
  userAgent: string | null;
  createdAt: string;
}

export interface SyncPushResult {
  kind: "ok" | "auth" | "batch_rejected" | "server" | "network" | "not_configured";
  message: string;
  pushedCount: number;
  skippedInvalidCount: number;
  boundInstance: string | null;
}

export interface SyncBatchOutcome {
  advancedTo: number; // 本批推进后的游标（原始扫描语义）
  obtained: SyncPushResult;
  batchSize: number; // 本批实际记录数（drop 计数用）
}

// 拉取原始扫描 max id（含 -1 记录）
async function scanMaxId(cursor: number): Promise<number> {
  const rows = (await withSkipCache(async () =>
    db
      .select({ maxId: sql<number>`COALESCE(MAX(${tokenRecords.id}), 0)` })
      .from(tokenRecords)
      .where(gt(tokenRecords.id, cursor))
  )) as Array<{ maxId: number }>;
  return Number(rows[0]?.maxId ?? 0);
}

// 拉取下一批可推送记录（过滤 -1 哨兵，id 升序）
async function fetchBatch(cursor: number, limit = BATCH_SIZE): Promise<SyncRecordRow[]> {
  const rows = (await withSkipCache(async () =>
    db
      .select({
        id: tokenRecords.id,
        model: tokenRecords.model,
        provider: tokenRecords.provider,
        agent: tokenRecords.agent,
        inputTokens: tokenRecords.inputTokens,
        outputTokens: tokenRecords.outputTokens,
        cacheRead: tokenRecords.cacheRead,
        cacheWrite: tokenRecords.cacheWrite,
        status: tokenRecords.status,
        latencyMs: tokenRecords.latencyMs,
        ttftMs: tokenRecords.ttftMs,
        requestModel: tokenRecords.requestModel,
        userAgent: tokenRecords.userAgent,
        createdAt: tokenRecords.createdAt,
      })
      .from(tokenRecords)
      .where(
        and(
          gt(tokenRecords.id, cursor),
          // SQLite 中 NULL != -1 为 falsy：本地记录（vk 为 NULL）必须显式放行
          sql`COALESCE(${tokenRecords.virtualKeyId}, 0) != ${REMOTE_SENTINEL_VK_ID}`
        )
      )
      .orderBy(tokenRecords.id)
      .limit(limit)
  )) as SyncRecordRow[];
  return rows;
}

function toPayload(row: SyncRecordRow): Record<string, unknown> {
  return {
    sourceRecordId: row.id,
    model: row.model,
    provider: row.provider,
    agent: row.agent,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    status: row.status ?? null,
    latencyMs: row.latencyMs ?? null,
    ttftMs: row.ttftMs ?? null,
    requestModel: row.requestModel ?? null,
    userAgent: row.userAgent ?? null,
    createdAt: row.createdAt,
  };
}

export class SyncPusher {
  private fetchImpl: typeof fetch;
  private dispatcher?: Dispatcher;
  private running = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private backoffMs = BASE_BACKOFF_MS;
  private batchRejectedCount = 0;

  constructor(opts: { fetchImpl?: typeof fetch; dispatcher?: Dispatcher } = {}) {
    this.fetchImpl = opts.fetchImpl ?? fetch;
    this.dispatcher = opts.dispatcher;
  }

  // fire-and-forget 通知（写库后调用；未配置时零开销）。
  // 直接触发 runLocked：running 时自然合并，timer 存在时可立即插队推送
  notify(): void {
    void this.runLocked();
  }

  // 显式触发（手动同步按钮）：立即尝试一轮
  async trigger(): Promise<void> {
    await this.runLocked();
  }

  // 60s 定时兜底（幂等；未配置时跳过启动）
  private schedule(ms: number): void {
    if (this.timer) return;
    const callback = () => {
      this.timer = null;
      void this.runLocked();
    };
    this.timer = setTimeout(callback, ms);
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  // 互斥锁：同一时刻只有一个推送循环（并发 notify 合并）
  private async runLocked(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.syncLoop();
    } catch (err) {
      console.error("[sync] push loop failed:", err);
      await this.recordError("internal", "push loop failed").catch(() => {});
      this.schedule(Math.min(this.backoffMs * 2, MAX_BACKOFF_MS));
    } finally {
      this.running = false;
    }
  }

  // 一轮完整推进（内部循环直到游标追平或遇到需退避的失败）
  private async syncLoop(): Promise<void> {
    const config = await loadSyncConfig();
    if (!config.targetUrl || !config.hasToken) {
      return; // 未配置：不启动
    }

    for (let rounds = 0; rounds < 1000; rounds++) {
      // 每轮重新读取配置：游标/epoch 在推进后变化，快照会重复推送
      const outcome = await this.pushOneBatch(await loadSyncConfig());
      if (outcome.obtained.kind === "ok") {
        // 追平则兜底调度，否则继续下一批
        const cursor = (await loadSyncConfig()).cursor;
        const maxId = await scanMaxId(cursor).catch(() => 0);
        if (maxId <= cursor) {
          this.schedule(RETRY_INTERVAL_MS);
          return;
        }
        continue;
      }
      // 失败：按类型决定退避或 drop（auth/server/network 无限退避）
      if (outcome.obtained.kind === "batch_rejected") {
        this.batchRejectedCount += 1;
        if (this.batchRejectedCount >= MAX_BATCH_REJECTED_RETRIES) {
          // 五十次拒绝 → 自动 drop 该批（数据永久跳过，可观测）
          await this.dropBatch(outcome.advancedTo, outcome.batchSize);
          this.batchRejectedCount = 0;
          this.backoffMs = BASE_BACKOFF_MS;
          continue; // 继续下一批
        }
      }
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS);
      this.schedule(this.backoffMs);
      return;
    }
  }

  // 推送一批：ack 成功后推进游标；返回结果与推进后的游标
  private async pushOneBatch(config: Awaited<ReturnType<typeof loadSyncConfig>>): Promise<SyncBatchOutcome> {
    const cursor = config.cursor;
    const maxId = await scanMaxId(cursor);
    if (maxId <= cursor) {
      return { advancedTo: cursor, obtained: { kind: "ok", message: "up to date", pushedCount: 0, skippedInvalidCount: 0, boundInstance: null }, batchSize: 0 };
    }

    const rows = await fetchBatch(cursor);
    if (rows.length === 0) {
      // 区间内只有 -1 哨兵记录：不推送，直接推进游标
      await setSyncCursor(maxId);
      return { advancedTo: maxId, obtained: { kind: "ok", message: "skipped remote records", pushedCount: 0, skippedInvalidCount: 0, boundInstance: null }, batchSize: 0 };
    }

    const result = await this.pushBatch(config, rows);
    if (result.kind !== "ok") {
      // batch_rejected 时返回本批终点（供 50 次后 drop 推进游标）；
      // 其余失败返回 cursor（游标不动，无限退避重试）
      const advancedTo = result.kind === "batch_rejected" ? rows[rows.length - 1]!.id : cursor;
      return { advancedTo, obtained: result, batchSize: rows.length };
    }

    // ack 成功：游标推进到本批最后（不足批则推进到原始扫描 max，跳过区间内残余 -1 记录）
    const advancedTo = rows.length < BATCH_SIZE ? maxId : rows[rows.length - 1]!.id;
    await setSyncCursor(advancedTo);
    this.batchRejectedCount = 0;
    this.backoffMs = BASE_BACKOFF_MS;
    await setSyncLastSuccessAt(new Date().toISOString());
    await setSyncLastError(null);

    if (result.boundInstance) {
      await setSyncBoundInstance(result.boundInstance);
    }
    if (result.skippedInvalidCount > 0) {
      await incrementDroppedCount(result.skippedInvalidCount);
    }
    return { advancedTo, obtained: result, batchSize: rows.length };
  }

  private async pushBatch(
    config: Awaited<ReturnType<typeof loadSyncConfig>>,
    rows: SyncRecordRow[]
  ): Promise<SyncPushResult> {
    const token = await getSyncToken();
    const targetUrl = config.targetUrl!;
    if (!token) {
      return { kind: "auth", message: "sync token is not configured", pushedCount: 0, skippedInvalidCount: 0, boundInstance: null };
    }
    await setSyncLastAttemptAt(new Date().toISOString());

    const payload = {
      instance: config.instance,
      epoch: config.epoch,
      records: rows.map(toPayload),
    };

    let response: Response;
    try {
      response = await this.fetchImpl(targetUrl, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${token}`,
          accept: "application/json",
        },
        body: JSON.stringify(payload),
        redirect: "manual",
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        ...(this.dispatcher ? { dispatcher: this.dispatcher } : {}),
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === "TimeoutError";
      const message = aborted ? "fetch timeout" : err instanceof Error ? err.message.slice(0, 200) : "network error";
      await this.recordError(aborted ? "network" : "network", message);
      return { kind: "network", message, pushedCount: 0, skippedInvalidCount: 0, boundInstance: null };
    }

    const status = response.status;
    const bodyText = await response.text().catch(() => "");
    let parsed: Record<string, unknown> | null = null;
    try {
      parsed = JSON.parse(bodyText) as Record<string, unknown>;
    } catch {
      parsed = null;
    }

    if (status >= 200 && status < 300) {
      const skippedInvalid = Array.isArray(parsed?.skippedInvalid) ? parsed.skippedInvalid.length : 0;
      const boundInstance =
        typeof parsed?.boundInstance === "string" && parsed.boundInstance !== ""
          ? (parsed.boundInstance as string)
          : (parsed?.boundInstance as string | null) ?? null;
      return {
        kind: "ok",
        message: `ack ${status}`,
        pushedCount: rows.length,
        skippedInvalidCount: skippedInvalid,
        boundInstance,
      };
    }

    if (status === 401 || status === 403) {
      await this.recordError("auth", `A rejected batch (HTTP ${status}${errorSuffix(parsed)})`);
      return { kind: "auth", message: `HTTP ${status}`, pushedCount: 0, skippedInvalidCount: 0, boundInstance: null };
    }
    if (status === 400) {
      await this.recordError("batch_rejected", `A rejected batch (HTTP 400${errorSuffix(parsed)})`);
      return { kind: "batch_rejected", message: `HTTP 400`, pushedCount: 0, skippedInvalidCount: 0, boundInstance: null };
    }
    // 429 / 5xx / 3xx
    await this.recordError(status >= 500 ? "server" : "network", `A returned HTTP ${status}${errorSuffix(parsed)}`);
    return {
      kind: status >= 500 ? "server" : "network",
      message: `HTTP ${status}`,
      pushedCount: 0,
      skippedInvalidCount: 0,
      boundInstance: null,
    };
  }

  private async dropBatch(advancedTo: number, pushedCount: number): Promise<void> {
    await setSyncCursor(advancedTo);
    await incrementDroppedCount(pushedCount);
    await setSyncLastError({
      type: "batch_rejected",
      message: `batch permanently skipped after ${MAX_BATCH_REJECTED_RETRIES} rejections (${pushedCount} records)`,
      firstFailedAt: new Date().toISOString(),
    });
    console.warn(`[sync] dropped batch of ${pushedCount} records at cursor=${advancedTo} (rejected 50x)`);
    await recordAuditLog({
      action: "sync_skip",
      targetType: "sync",
      details: { auto: true, cursor: advancedTo, count: pushedCount },
    }).catch(() => {});
  }

  private async recordError(type: SyncLastError["type"], message: string): Promise<void> {
    const prev = (await loadSyncConfig()).lastError;
    await setSyncLastError({
      type,
      message,
      firstFailedAt: prev?.firstFailedAt ?? new Date().toISOString(),
    });
  }
}

function errorSuffix(parsed: Record<string, unknown> | null): string {
  if (parsed && typeof parsed.error === "string" && parsed.error.length > 0) {
    return `: ${parsed.error.slice(0, 120)}`;
  }
  return "";
}

// 模块级单例（与 health.ts / session.ts 同范式）
export const syncPusher = new SyncPusher();