import { eq, sql, and } from "drizzle-orm";
import {
  db,
  initDatabase,
  upstreamsTable,
  upstreamKeysTable,
  virtualKeysTable,
  tokenRecords,
  upstreamModelHealthTable,
  routingRulesTable,
} from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { decryptSecret, safeCompare } from "./crypto";
import type { ProxyDeps, RecordUsageMeta } from "./proxy";
import type { UpstreamRoute, RoutingRule } from "./model-router";
import type { QuotaUsage } from "./quota";
import { parseEnabledModels } from "./model-router";
import type { Protocol } from "./model-router";
import { SessionStore } from "./session";
import { HealthTracker } from "./health";
import type { HealthPersistence } from "./health";
import { probeModel } from "./probe";

// 模块级单例：session binding 与健康状态必须在请求间共享
// （createProxyDeps() 是每请求创建的，不能把状态放进 deps 实例）
const sessionStore = new SessionStore();

// 解密指定 upstream 的所有启用 key（明文，按配置顺序）
export async function loadPlainUpstreamKeys(upstreamId: number): Promise<string[]> {
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
}

// 探活：health_check_model 优先，否则 enabled_models 中第一个非通配 model；
// 无可探活 model / 无 key 时返回 false（保持 unhealthy）
async function probeUpstream(upstreamId: number): Promise<boolean> {
  await initDatabase();
  const upstream = (
    await db.select().from(upstreamsTable).where(eq(upstreamsTable.id, upstreamId))
  )[0];
  if (!upstream) return false;

  let model: string | null = upstream.healthCheckModel ?? null;
  if (!model) {
    const models = parseEnabledModels(upstream.enabledModels).filter((m) => !m.endsWith("*"));
    model = models[0] ?? null;
  }
  if (!model) return false;

  const keys = await loadPlainUpstreamKeys(upstreamId);
  if (keys.length === 0) return false;

  const result = await probeModel(
    { protocol: upstream.protocol as Protocol, baseUrl: upstream.baseUrl },
    model,
    keys[0]
  );
  if (result.ok) {
    console.log(`[gateway] upstream "${upstream.name}" recovered via probe (model=${model})`);
  } else {
    console.log(
      `[gateway] upstream "${upstream.name}" probe failed (model=${model}, status=${result.status}${
        result.error ? `, ${result.error.slice(0, 200)}` : ""
      })`
    );
  }
  return result.ok;
}

// 健康状态持久化：upstream 级存 upstreams.health_status，model 级存 upstream_model_health
const healthPersistence: HealthPersistence = {
  async loadUpstreams() {
    await initDatabase();
    const rows = await db
      .select({ id: upstreamsTable.id })
      .from(upstreamsTable)
      .where(eq(upstreamsTable.healthStatus, "unhealthy"));
    return rows.map((r: any) => r.id);
  },

  async loadModels() {
    await initDatabase();
    const rows = await db.select().from(upstreamModelHealthTable);
    return rows.map((r: any) => ({
      upstreamId: r.upstreamId,
      model: r.model,
      expiresAt: new Date(r.expiresAt).getTime(),
    }));
  },

  async saveUpstream(upstreamId, unhealthy) {
    await initDatabase();
    return withSkipCache(async () => {
      await db
        .update(upstreamsTable)
        .set({
          healthStatus: unhealthy ? "unhealthy" : null,
          healthUpdatedAt: new Date().toISOString(),
        })
        .where(eq(upstreamsTable.id, upstreamId));
    });
  },

  async saveModel(upstreamId, model, expiresAt) {
    await initDatabase();
    return withSkipCache(async () => {
      if (expiresAt === null) {
        await db
          .delete(upstreamModelHealthTable)
          .where(
            and(
              eq(upstreamModelHealthTable.upstreamId, upstreamId),
              eq(upstreamModelHealthTable.model, model)
            )
          );
      } else {
        const now = new Date().toISOString();
        await db
          .insert(upstreamModelHealthTable)
          .values({
            upstreamId,
            model,
            status: "unavailable",
            expiresAt: new Date(expiresAt).toISOString(),
            updatedAt: now,
          })
          .onConflictDoUpdate({
            target: [upstreamModelHealthTable.upstreamId, upstreamModelHealthTable.model],
            set: { status: "unavailable", expiresAt: new Date(expiresAt).toISOString(), updatedAt: now },
          });
      }
    });
  },
};

const healthTracker = new HealthTracker(probeUpstream, healthPersistence);

export { healthTracker };

// 加载全部手动路由规则（SELECT 走现有 10s 查询缓存，命中即短路自动路由）
export async function loadRoutingRules(): Promise<RoutingRule[]> {
  await initDatabase();
  const rows = await db.select().from(routingRulesTable);
  return rows.map((row: any): RoutingRule => ({
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    upstreamId: row.upstreamId,
    targetModel: row.targetModel,
  }));
}

// 惰性构建：tokenRecords 在模块加载时为 undefined，必须在首次使用（函数体内）时引用
function tokenSumSql() {
  return sql`COALESCE(SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.outputTokens}) + SUM(${tokenRecords.cacheRead}) + SUM(${tokenRecords.cacheWrite}), 0)`;
}

// 代理路由的依赖实现（Next.js 服务端使用）
export function createProxyDeps(): ProxyDeps {
  return {
    // 认证类读取必须 withSkipCache：vk/上游被吊销或禁用后立即生效，
    // 否则查询缓存 10s 内旧结果仍可透传
    async resolveVirtualKey(token) {
      await initDatabase();
      return withSkipCache(async () => {
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
      });
    },

    async resolveUpstreamKeys(upstreamId) {
      return withSkipCache(() => loadPlainUpstreamKeys(upstreamId));
    },

    async loadUpstreams() {
      await initDatabase();
      return withSkipCache(async () => {
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
      });
    },

    async loadRoutingRules() {
      return loadRoutingRules();
    },

    async resolveStreamIdleTimeoutMs() {
      const { resolveStreamIdleTimeoutMs } = await import("@/lib/auth/settings");
      return resolveStreamIdleTimeoutMs();
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
          targetModel: usage.targetModel ?? null,
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
              rpm: sql`COUNT(*)`,
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

    session: {
      getBinding: (sessionId) => sessionStore.get(sessionId),
      setBinding: (sessionId, upstreamId) => sessionStore.set(sessionId, upstreamId),
    },

    health: {
      isHealthy: (upstreamId) => healthTracker.isHealthy(upstreamId),
      markUnhealthy: (upstreamId) => healthTracker.markUnhealthy(upstreamId),
      isModelHealthy: (upstreamId, model) => healthTracker.isModelHealthy(upstreamId, model),
      markModelUnhealthy: (upstreamId, model) => healthTracker.markModelUnhealthy(upstreamId, model),
    },

    log: (message) => console.log(message),
  };
}
