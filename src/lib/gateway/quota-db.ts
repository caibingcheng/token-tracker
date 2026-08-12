import { sql, inArray, and } from "drizzle-orm";
import { db, initDatabase, tokenRecords } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import type { QuotaUsage } from "./quota";

// 惰性构建：tokenRecords 在模块加载时为 undefined，必须在首次使用（函数体内）时引用
export function quotaTokenSumSql() {
  return sql`COALESCE(SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.outputTokens}) + SUM(${tokenRecords.cacheRead}) + SUM(${tokenRecords.cacheWrite}), 0)`;
}

// 配额窗口用量加载：3 条聚合 SELECT（RPM/TPM 共用 60s 窗口合并为 1 条），
// 均包 withSkipCache 直查保证实时；token 口径 = input + output + cache_read + cache_write
export async function loadQuotaUsageFromDb(
  virtualKeyId: number,
  now: Date
): Promise<QuotaUsage> {
  await initDatabase();
  return withSkipCache(async () => {
    const sixtySecondsAgo = new Date(now.getTime() - 60_000).toISOString();
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();

    const windowRow = (
      await db
        .select({
          rpm: sql`COUNT(*)`,
          tpm: quotaTokenSumSql(),
        })
        .from(tokenRecords)
        .where(
          sql`${tokenRecords.virtualKeyId} = ${virtualKeyId} AND ${tokenRecords.createdAt} >= ${sixtySecondsAgo}`
        )
    )[0];

    const dayRow = (
      await db
        .select({ tokens: quotaTokenSumSql() })
        .from(tokenRecords)
        .where(
          sql`${tokenRecords.virtualKeyId} = ${virtualKeyId} AND ${tokenRecords.createdAt} >= ${dayStart}`
        )
    )[0];

    const monthRow = (
      await db
        .select({ tokens: quotaTokenSumSql() })
        .from(tokenRecords)
        .where(
          sql`${tokenRecords.virtualKeyId} = ${virtualKeyId} AND ${tokenRecords.createdAt} >= ${monthStart}`
        )
    )[0];

    return {
      rpm: Number(windowRow?.rpm ?? 0),
      tpm: Number(windowRow?.tpm ?? 0),
      dailyTokens: Number(dayRow?.tokens ?? 0),
      monthlyTokens: Number(monthRow?.tokens ?? 0),
    };
  });
}

// 批量版（admin 列表用）：一次 GROUP BY 返回多个 vk 的窗口用量，避免 N+1
export async function loadQuotaUsageBatch(
  virtualKeyIds: number[],
  now: Date
): Promise<Map<number, QuotaUsage>> {
  if (virtualKeyIds.length === 0) return new Map();
  await initDatabase();
  return withSkipCache(async () => {
    const ids = virtualKeyIds;
    const sixtySecondsAgo = new Date(now.getTime() - 60_000).toISOString();
    const dayStart = `${now.toISOString().slice(0, 10)}T00:00:00.000Z`;
    const monthStart = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
    ).toISOString();

    const windowRows = await db
      .select({
        id: tokenRecords.virtualKeyId,
        rpm: sql`COUNT(*)`,
        tpm: quotaTokenSumSql(),
      })
      .from(tokenRecords)
      .where(
        and(inArray(tokenRecords.virtualKeyId, ids), sql`${tokenRecords.createdAt} >= ${sixtySecondsAgo}`)
      )
      .groupBy(tokenRecords.virtualKeyId);

    const dayRows = await db
      .select({
        id: tokenRecords.virtualKeyId,
        tokens: quotaTokenSumSql(),
      })
      .from(tokenRecords)
      .where(
        and(inArray(tokenRecords.virtualKeyId, ids), sql`${tokenRecords.createdAt} >= ${dayStart}`)
      )
      .groupBy(tokenRecords.virtualKeyId);

    const monthRows = await db
      .select({
        id: tokenRecords.virtualKeyId,
        tokens: quotaTokenSumSql(),
      })
      .from(tokenRecords)
      .where(
        and(inArray(tokenRecords.virtualKeyId, ids), sql`${tokenRecords.createdAt} >= ${monthStart}`)
      )
      .groupBy(tokenRecords.virtualKeyId);

    const result = new Map<number, QuotaUsage>();
    for (const id of ids) {
      result.set(id, { rpm: 0, tpm: 0, dailyTokens: 0, monthlyTokens: 0 });
    }
    for (const row of windowRows) {
      const entry = result.get(Number(row.id));
      if (entry) {
        entry.rpm = Number(row.rpm);
        entry.tpm = Number(row.tpm);
      }
    }
    for (const row of dayRows) {
      const entry = result.get(Number(row.id));
      if (entry) entry.dailyTokens = Number(row.tokens);
    }
    for (const row of monthRows) {
      const entry = result.get(Number(row.id));
      if (entry) entry.monthlyTokens = Number(row.tokens);
    }
    return result;
  });
}
