import { eq, and, lt } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable, virtualKeysTable, tokenRecords, upstreamModelHealthTable, namedRoutesTable, namedRouteTargetsTable, responseBindingsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { decryptSecret, safeCompare, GatewaySecretMissingError } from "./crypto";
import { virtualKeyFingerprint } from "./vk-fingerprint";
import type { ProxyDeps, RecordUsageMeta } from "./proxy";
import type { UpstreamRoute, NamedRoute, NamedRouteTarget } from "./model-router";
import { parseEnabledModels } from "./model-router";
import type { Protocol } from "./model-router";
import { SessionStore } from "./session";
import { parseHeaderTransforms } from "./header-transforms";
import { parseModelProbeConfigs, parseProbeConfig } from "./probe-config";
import { HealthTracker } from "./health";
import type { HealthPersistence } from "./health";
import { probeModelWithKeys } from "./probe";
import { loadQuotaUsageFromDb } from "./quota-db";

// 模块级单例：session binding 与健康状态必须在请求间共享
// （createProxyDeps() 是每请求创建的，不能把状态放进 deps 实例）
const sessionStore = new SessionStore();

// 解密指定 upstream 的通用 key（device_id IS NULL，明文，按配置顺序）。
// 直连路径（proxy）只看通用 key：per-device key 绝不能污染全局探活/分类器判定。
export async function loadPlainUpstreamKeys(upstreamId: number): Promise<string[]> {
  const keys = await loadPlainUpstreamKeysForDevice(upstreamId, null);
  return keys.map((k) => k.apiKey);
}

// 解密指定 upstream 的 key（带 id）：deviceId = null → 只返回通用 key（现有行为）；
// deviceId 非空 → 通用 key + 该 device 专属 key，专属优先（per-device key 开关）。
export async function loadPlainUpstreamKeysForDevice(
  upstreamId: number,
  deviceId: number | null
): Promise<{ id: number; apiKey: string }[]> {
  await initDatabase();
  const rows = await db
    .select()
    .from(upstreamKeysTable)
    .where(eq(upstreamKeysTable.upstreamId, upstreamId))
    .orderBy(upstreamKeysTable.id);
  const scoped = rows.filter((row: any) =>
    deviceId === null ? row.deviceId === null : row.deviceId === null || row.deviceId === deviceId
  );
  // 专属 key 优先（device_id IS NULL 排后）
  scoped.sort((a: any, b: any) => {
    const aGeneric = a.deviceId === null ? 1 : 0;
    const bGeneric = b.deviceId === null ? 1 : 0;
    return aGeneric - bGeneric || a.id - b.id;
  });
  const keys: { id: number; apiKey: string }[] = [];
  for (const row of scoped) {
    if (row.enabled !== 1) continue;
    try {
      keys.push({ id: row.id, apiKey: decryptSecret(row.apiKeyEncrypted) });
    } catch (err) {
      // GATEWAY_SECRET 缺失必须向上传播（fail-closed），不能吞掉降级为"无 key"
      if (err instanceof GatewaySecretMissingError) throw err;
      continue;
    }
  }
  return keys;
}

// 探活：health_check_model 优先，否则 enabled_models 中第一个非通配 model；
// 无可探活 model / 无 key 时返回失败（保持 unhealthy）。
// 全 key 链逐个探测（与真实请求/手动 test-model 口径一致），任一 key 成功即恢复；
// 404 放宽：全部 key 均返回 403/404（model 级问题）且未出现 401 → 视为 upstream 级恢复
// （上游可达 + key 有效，仅探测 model 被下架/改名，连通性已恢复），401 不放宽。
async function probeUpstream(
  upstreamId: number
): Promise<{ ok: boolean; status?: number; error?: string }> {
  await initDatabase();
  const upstream = (
    await db.select().from(upstreamsTable).where(eq(upstreamsTable.id, upstreamId))
  )[0];
  if (!upstream) return { ok: false };

  let model: string | null = upstream.healthCheckModel ?? null;
  if (!model) {
    const models = parseEnabledModels(upstream.enabledModels).filter((m) => !m.endsWith("*"));
    model = models[0] ?? null;
  }
  if (!model) return { ok: false };

  let keys: string[];
  try {
    keys = await loadPlainUpstreamKeys(upstreamId);
  } catch (err) {
    // GATEWAY_SECRET 缺失：探活无法解密 key，保持 unhealthy（fail-closed）
    if (err instanceof GatewaySecretMissingError) {
      console.log("[gateway] probe skipped: GATEWAY_SECRET is not configured");
      return { ok: false };
    }
    throw err;
  }
  if (keys.length === 0) return { ok: false };

  const result = await probeModelWithKeys(
    {
      protocol: upstream.protocol as Protocol,
      baseUrl: upstream.baseUrl,
      proxyUrl: decryptProxyUrl(upstream.proxyUrlEncrypted),
      headerTransforms: parseHeaderTransforms(upstream.headerTransforms),
      probeConfig: parseProbeConfig(upstream.probeConfig),
      modelProbeConfigs: parseModelProbeConfigs(upstream.modelProbeConfigs),
      upstreamName: upstream.name,
    },
    model,
    keys
  );
  // 404 放宽：上游可达 + key 有效，仅探测 model 不存在 → upstream 级恢复
  const recovered = result.ok || (result.sawModelError && !result.sawAuthError);
  if (recovered) {
    // 恢复时清被探测 model 的不可用标记（与兜底自愈「清当跳 model」口径对齐）
    await healthTracker.markModelHealthy(upstreamId, model);
    if (result.ok) {
      console.log(`[gateway] upstream "${upstream.name}" recovered via probe (model=${model})`);
    } else {
      console.log(
        `[gateway] upstream "${upstream.name}" recovered via probe relaxation: model "${model}" may be delisted/renamed (status=${result.status})`
      );
    }
  } else if (result.sawAuthError) {
    console.log(
      `[gateway] upstream "${upstream.name}" probe failed: all keys rejected (401) — replace the API keys (model=${model})`
    );
  } else {
    console.log(
      `[gateway] upstream "${upstream.name}" probe failed (model=${model}, status=${result.status}${
        result.error ? `, ${result.error.slice(0, 200)}` : ""
      })`
    );
  }
  return { ok: recovered, status: result.status, error: result.error };
}

// 健康状态持久化：upstream 级存 upstreams.health_status，model 级存 upstream_model_health
const healthPersistence: HealthPersistence = {
  async loadUpstreams() {
    await initDatabase();
    // 只调度 enabled 的 unhealthy upstream：禁用的不挂探活 timer（DB 状态保留，
    // 供 UI 展示与重新启用时恢复）
    const rows = await db
      .select({ id: upstreamsTable.id })
      .from(upstreamsTable)
      .where(and(eq(upstreamsTable.healthStatus, "unhealthy"), eq(upstreamsTable.enabled, 1)));
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

export { healthTracker, sessionStore };

// 加载全部命名路由（SELECT 走现有 10s 查询缓存，命中即短路自动路由）
export async function loadNamedRoutes(): Promise<NamedRoute[]> {
  await initDatabase();
  const rows = await db.select().from(namedRoutesTable);
  return rows.map((row: any): NamedRoute => ({
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    instruction: row.instruction ?? "",
    classifierUpstreamId: row.classifierUpstreamId ?? 0,
    classifierModel: row.classifierModel ?? "",
    classifierKind: row.classifierKind === "model" ? "model" : "priority",
    enabled: row.enabled === 1,
  }));
}

// 加载某条命名路由的目标池（表小，直查）
export async function loadNamedRouteTargets(namedRouteId: number): Promise<NamedRouteTarget[]> {
  await initDatabase();
  const rows = await db
    .select()
    .from(namedRouteTargetsTable)
    .where(eq(namedRouteTargetsTable.namedRouteId, namedRouteId));
  return rows.map((row: any): NamedRouteTarget => ({
    id: row.id,
    namedRouteId: row.namedRouteId,
    upstreamId: row.upstreamId,
    upstreamModel: row.upstreamModel,
    description: row.description ?? null,
    priority: row.priority ?? 0,
  }));
}

// 解密上游代理 URL；GATEWAY_SECRET 缺失必须向上传播（fail-closed，与 key 解密同口径）
export function decryptProxyUrl(encrypted: string | null | undefined): string | null {
  if (!encrypted) return null;
  return decryptSecret(encrypted);
}

// responses create 的 id 归属：写入时顺手清 30 天前的旧行（best-effort，幂等）。
// 只存 id + vk id，不存任何请求/响应内容。
export const RESPONSE_BINDING_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export async function saveResponseBinding(
  responseId: string,
  virtualKeyId: number
): Promise<void> {
  await initDatabase();
  await withSkipCache(async () => {
    const now = new Date().toISOString();
    await db
      .insert(responseBindingsTable)
      .values({ responseId, virtualKeyId, createdAt: now })
      .onConflictDoUpdate({
        target: responseBindingsTable.responseId,
        set: { virtualKeyId, createdAt: now },
      });
    const cutoff = new Date(Date.now() - RESPONSE_BINDING_TTL_MS).toISOString();
    await db.delete(responseBindingsTable).where(lt(responseBindingsTable.createdAt, cutoff));
  });
}

// 归属查询：null = 无映射（调用方放行，过渡期兼容存量 id）
export async function lookupResponseBinding(responseId: string): Promise<number | null> {
  await initDatabase();
  return withSkipCache(async () => {
    const row = (
      await db
        .select()
        .from(responseBindingsTable)
        .where(eq(responseBindingsTable.responseId, responseId))
    )[0];
    return row?.virtualKeyId ?? null;
  });
}

// 代理路由的依赖实现（Next.js 服务端使用）
export function createProxyDeps(): ProxyDeps {
  return {
    // 认证类读取必须 withSkipCache：vk/上游被吊销或禁用后立即生效，
    // 否则查询缓存 10s 内旧结果仍可透传
    async resolveVirtualKey(token) {
      await initDatabase();
      return withSkipCache(async () => {
        // ① 指纹索引命中 → 仍用 safeCompare 复核（指纹只做索引，不作为放行依据）
        const fingerprint = virtualKeyFingerprint(token);
        const indexed = await db
          .select()
          .from(virtualKeysTable)
          .where(eq(virtualKeysTable.keyFingerprint, fingerprint));
        for (const row of indexed) {
          try {
            if (safeCompare(decryptSecret(row.apiKeyEncrypted), token)) {
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
          } catch (err) {
            if (err instanceof GatewaySecretMissingError) throw err;
          }
        }

        // ② 指纹未命中，或命中但复核失败 → 回退全表解密比对（保留既有行为，
        //    未回填指纹的库（key_fingerprint IS NULL）也走这条）
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
          } catch (err) {
            // GATEWAY_SECRET 缺失必须向上传播（fail-closed），不能吞掉降级为 401
            if (err instanceof GatewaySecretMissingError) throw err;
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
            proxyUrl: decryptProxyUrl(row.proxyUrlEncrypted),
            headerTransforms: parseHeaderTransforms(row.headerTransforms),
            classifierModels: row.classifierModels ?? null,
          })
        );
      });
    },

    async loadNamedRoutes() {
      return loadNamedRoutes();
    },

    async loadNamedRouteTargets(namedRouteId: number) {
      const targets = await loadNamedRouteTargets(namedRouteId);
      return targets.map((t) => ({
        id: t.id,
        upstreamId: t.upstreamId,
        targetModel: t.upstreamModel,
        description: t.description,
        priority: t.priority,
      }));
    },

    // 分类器决策：直连 classifier upstream（keys 解密 fail-closed；models.dev 快照查 context window）
    async runClassifier(opts) {
      const { runClassifier } = await import("./classifier");
      const { getSnapshot } = await import("@/lib/models-dev/snapshot");
      const { lookupContextWindow } = await import("./classifier/budget");
      const { loadModelsDevSource } = await import("@/lib/auth/settings-models-dev-source");
      return runClassifier({
        ...opts,
        deps: {
          resolveUpstreamKeys: (upstreamId: number) =>
            withSkipCache(() => loadPlainUpstreamKeys(upstreamId)),
          lookupContextWindow: async (model: string) => {
            const snapshot = await getSnapshot({ source: await loadModelsDevSource() });
            return snapshot ? lookupContextWindow(model, snapshot.data) : null;
          },
          log: (message: string) => console.log(message),
        },
      });
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
          ttftMs: usage.ttftMs ?? null,
          virtualKeyId: usage.virtualKeyId ?? null,
          userAgent: usage.userAgent ?? null,
          sessionId: usage.sessionId ?? null,
          requestModel: usage.requestModel ?? null,
        });
        // fire-and-forget 通知推送 worker（未配置同步时零开销）
        const { syncPusher } = await import("@/lib/sync/pusher");
        syncPusher.notify();
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

    // responses create 的 response id 归属（子路径透传时拦跨 vk retrieve）
    async onResponseCreated(responseId, virtualKeyId) {
      await saveResponseBinding(responseId, virtualKeyId);
    },

    async lookupResponseOwner(responseId) {
      return lookupResponseBinding(responseId);
    },

// 配额用量加载：共享实现见 quota-db.ts（3 条聚合 SELECT，RPM/TPM 共用 60s 窗口，
// withSkipCache 直查保证实时；token 口径 = input + output + cache_read + cache_write）
quota: {
  loadUsage: (virtualKeyId, now) => loadQuotaUsageFromDb(virtualKeyId, now),
},

    session: {
      getBinding: (sessionId) => sessionStore.get(sessionId),
      setBinding: (sessionId, upstreamId, targetModel) =>
        sessionStore.set(sessionId, upstreamId, targetModel),
    },

    health: {
      isHealthy: (upstreamId) => healthTracker.isHealthy(upstreamId),
      markUnhealthy: (upstreamId) => healthTracker.markUnhealthy(upstreamId),
      markHealthy: (upstreamId) => healthTracker.markHealthy(upstreamId),
      isModelHealthy: (upstreamId, model) => healthTracker.isModelHealthy(upstreamId, model),
      markModelUnhealthy: (upstreamId, model) => healthTracker.markModelUnhealthy(upstreamId, model),
      markModelHealthy: (upstreamId, model) => healthTracker.markModelHealthy(upstreamId, model),
      isGivenUp: (upstreamId) => healthTracker.isGivenUp(upstreamId),
    },

    log: (message) => console.log(message),
  };
}
