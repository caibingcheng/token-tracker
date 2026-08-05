import { eq } from "drizzle-orm";
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

    log: (message) => console.log(message),
  };
}
