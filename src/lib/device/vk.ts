// relay 侧的 vk 解析：只按指纹索引查（plan 请求不携带明文 vk，无法做 safeCompare 复核）。
// 与 resolveVirtualKey 的关系：同一份「指纹 → 行」索引；未回填指纹的行（
// key_fingerprint IS NULL）在 relay 路径上不可用 —— 中心启动时已幂等回填，
// 回填失败（GATEWAY_SECRET 缺失）时代理路由本身也不可用，所以不构成新的失败面。
import { eq } from "drizzle-orm";
import { db, initDatabase, virtualKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import type { VirtualKeyInfo } from "@/lib/gateway/proxy";

export async function resolveVirtualKeyByFingerprint(
  fingerprint: string
): Promise<VirtualKeyInfo | null> {
  await initDatabase();
  return withSkipCache(async () => {
    const rows = await db
      .select()
      .from(virtualKeysTable)
      .where(eq(virtualKeysTable.keyFingerprint, fingerprint));
    const row = rows[0];
    if (!row) return null;
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
  });
}
