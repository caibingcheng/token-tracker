import { eq, sql } from "drizzle-orm";
import {
  db,
  initDatabase,
  upstreamsTable,
  upstreamKeysTable,
  virtualKeysTable,
  tokenRecords,
} from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { decryptSecret, safeCompare } from "./crypto";
import type { ProxyDeps, RecordUsageMeta } from "./proxy";
import type { UpstreamRoute } from "./model-router";
import type { QuotaUsage } from "./quota";

// 惰性构建：tokenRecords 在模块加载时为 undefined，必须在首次使用（函数体内）时引用
function tokenSumSql() {
  return sql<number>`COALESCE(SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.outputTokens}) + SUM(${tokenRecords.cacheRead}) + SUM(${tokenRecords.cacheWrite}), 0)`;
}

// 代理路由的依赖实现（Next.js 服务端使用）
export function createProxyDeps(): ProxyDeps {
  return {
    async resolveVirtualKey(token) {
      await initDatabase();
      const rows = await db.select().from(virtualKeysTable);
      for (const row of rows) {
        try {
          const plain = decryptSecret(row.apiKeyEncrypted);
          if (safeCompare(plain, token)) {
            return {
              id: row.id,
              name: row.name,
              enabled: row.enabled === 1,
              enabledModels: row.enabledModels,
              maxRpm: row.maxRpm ?? null,
              maxTpm: row.maxTpm ?? null,
              maxDailyTokens: row.maxDailyTokens ?? null,
              maxMonthlyTokens: row.maxMonthlyTokens ?? null,
            };
          }
        } catch {
          continue;
        }
      }
      return null;
    },

    async resolveUpstreamKeys(upstreamId) {
      await initDatabase();
      const rows = await db
        .select()
        .from(upstreamKeysTable)
        .where(eq(upstreamKeysTable.upstreamId, upstreamId))
        .orderBy(upstreamKeysTable.id);
      const keys: string[] = [];
      for (const row of rows) {
        if (row.enabled !== 1) continue;
        try {
          keys.push(decryptSecret(row.apiKeyEncrypted));
        } catch {
          continue;
        }
      }
      return keys;
    },

    async loadUpstreams() {
      await initDatabase();
      const rows = await db.select().from(upstreamsTable).orderBy(upstreamsTable.priority);
      return rows
        .filter((row: any) => row.enabled === 1)
        .map(
          (row: any): UpstreamRoute => ({
            id: row.id,
            name: row.name,
            protocol: row.protocol,
            baseUrl: row.baseUrl,
            priority: row.priority,
            enabled: true,
            enabledModels: row.enabledModels,
          })
        );
    },

    // 写库走 withSkipCache：INSERT 自动触发 invalidateQueryCache()，Dashboard 即时可见
    async onUsage(usage: RecordUsageMeta) {
      await initDatabase();
      return withSkipCache(async () => {
        await db.insert(tokenRecords).values({
          model: usage.model,
          provider: usage.provider,
          agent: usage.agent,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          status: usage.status ?? null,
          latencyMs: usage.latencyMs ?? null,
          virtualKeyId: usage.virtualKeyId ?? null,
          userAgent: usage.userAgent ?? null,
        });
      });
    },

    async onComplete({ virtualKeyId }) {
      await initDatabase();
      return withSkipCache(async () => {
        await db
          .update(virtualKeysTable)
          .set({ lastUsedAt: new Date().toISOString() })
          .where(eq(virtualKeysTable.id, virtualKeyId));
      });
    },

    // 配额用量加载：4 条聚合 SELECT（RPM/TPM 共用 60s 窗口合并为 1 条），
    // 均包 withSkipCache 直查保证实时；token 口径 = input + output + cache_read + cache_write
    quota: {
      async loadUsage(virtualKeyId, now) {
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
              rpm: sql<number>`COUNT(*)`,
              tpm: tokenSumSql(),
            })
            .from(tokenRecords)
            .where(
              sql`${tokenRecords.virtualKeyId} = ${virtualKeyId} AND ${tokenRecords.createdAt} >= ${sixtySecondsAgo}`
            )
        )[0];

        const dayRow = (
          await db
            .select({ tokens: tokenSumSql() })
            .from(tokenRecords)
            .where(
              sql`${tokenRecords.virtualKeyId} = ${virtualKeyId} AND ${tokenRecords.createdAt} >= ${dayStart}`
            )
        )[0];

        const monthRow = (
          await db
            .select({ tokens: tokenSumSql() })
            .from(tokenRecords)
            .where(
              sql`${tokenRecords.virtualKeyId} = ${virtualKeyId} AND ${tokenRecords.createdAt} >= ${monthStart}`
            )
        )[0];

        const usage: QuotaUsage = {
          rpm: Number(windowRow?.rpm ?? 0),
          tpm: Number(windowRow?.tpm ?? 0),
          dailyTokens: Number(dayRow?.tokens ?? 0),
          monthlyTokens: Number(monthRow?.tokens ?? 0),
        };
        return usage;
      });
      },
    },

    log: (message) => console.log(message),
  };
}
