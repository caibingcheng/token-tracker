import { eq, gte } from "drizzle-orm";
import { db, initDatabase, modelPricesTable, upstreamsTable, tokenRecords, syncInstancesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { sql } from "drizzle-orm";
import { parseEnabledModels } from "@/lib/gateway/model-router";
import { getSnapshot, type ModelsDevSnapshot } from "@/lib/models-dev/snapshot";
import { matchModelsDevModel } from "@/lib/models-dev/match";
import {
  autoFillModelPrices,
  type AutoFillModelPrice,
} from "@/lib/models-dev/auto-fill";
import { invalidatePriceCache } from "@/lib/pricing";
import { loadModelsDevSource } from "@/lib/auth/settings-models-dev-source";

// model_prices 管理服务层：行集 = 全部 upstream enabled_models（非通配，去重）
// ∪ 已定价 model ∪ 近期推送记录出现过的 model（可被发现、可补价），
// 附徽标状态判定（active/inactive/待确认/未匹配/有更新/已下架）+ 近期流量可见性。

// 近期流量窗口：近 30 天有记录（含推送）→ 默认可见；过期自动隐藏
export const RECENT_ACTIVITY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface ModelPriceRow {
  model: string;
  upstreams: string[]; // 本机 upstream 名 + 近期推送来源（remote/{instance}/{upstream}）
  inputPrice: number | null;
  outputPrice: number | null;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  source: "models.dev" | "github" | "manual" | null;
  modelsDevId: string | null;
  sourceProvider: string | null; // 自动来源（models.dev / github）的 provider 显示名（manual 为 null）
  updatedAt: string | null;
  recentActivity: boolean; // 近 30 天有记录（含推送）→ 默认可见
  status: {
    active: boolean;
    inactive: boolean;
    pending: boolean; // 未定价且候选 >1 且价格不一致
    unmatched: boolean; // 未定价且无候选
    hasUpdate: boolean; // source=models.dev/github 且快照同 id 价格不同
    removed: boolean; // source=models.dev/github 且快照无该 id
    diff: {
      inputPrice: number;
      outputPrice: number;
      cacheReadPrice: number | null;
      cacheWritePrice: number | null;
    } | null;
  };
}

// 所有启用 upstream 的非通配 enabled_models（去重），带 upstream 名
export async function loadUpstreamModelRows(): Promise<
  Array<{ model: string; upstreamName: string }>
> {
  await initDatabase();
  const rows = await withSkipCache(async () =>
    db.select().from(upstreamsTable).where(eq(upstreamsTable.enabled, 1))
  );
  const result: Array<{ model: string; upstreamName: string }> = [];
  for (const row of rows) {
    const models = parseEnabledModels(row.enabledModels);
    for (const m of models) {
      if (!m || m.endsWith("*")) continue;
      result.push({ model: m, upstreamName: row.name });
    }
  }
  return result;
}

export async function loadPricedModels(): Promise<
  Array<{
    model: string;
    inputPrice: number;
    outputPrice: number;
    cacheReadPrice: number | null;
    cacheWritePrice: number | null;
    source: string;
    modelsDevId: string | null;
    updatedAt: string;
  }>
> {
  await initDatabase();
  return withSkipCache(async () => db.select().from(modelPricesTable));
}

// ---- 近期推送来源模型：sync_instances 实例名驱动的 provider 前缀匹配（有界 distinct + 内存缓存）----

let remoteModelCache: {
  at: number;
  rows: Array<{ model: string; providers: string[] }>;
} | null = null;

const REMOTE_MODEL_CACHE_TTL_MS = 60_000;

export function invalidateRemoteModelCache(): void {
  remoteModelCache = null;
}

async function loadRemoteModelRows(): Promise<
  Array<{ model: string; providers: string[] }>
> {
  const now = Date.now();
  if (remoteModelCache && now - remoteModelCache.at < REMOTE_MODEL_CACHE_TTL_MS) {
    return remoteModelCache.rows;
  }
  await initDatabase();
  const instances = (await withSkipCache(async () =>
    db
      .select({ uid: syncInstancesTable.uid, instanceName: syncInstancesTable.instanceName })
      .from(syncInstancesTable)
  )) as Array<{ uid: string; instanceName: string | null }>;
  const map = new Map<string, Set<string>>();
  for (const inst of instances) {
    // 全历史推送模型（行集可发现、可补价）；近期流量由 recentActivity 单独判定。
    // uid 等值匹配（身份键，改名后历史行仍命中）+ instanceName LIKE 前缀兜底
    // （uid 列迁移前写入的旧行保持 NULL，OR 关系）
    const uidCond = sql`${tokenRecords.remoteInstanceUid} = ${inst.uid}`;
    const likeCond =
      inst.instanceName && inst.instanceName.trim() !== ""
        ? sql`${tokenRecords.provider} LIKE ${`remote/${inst.instanceName}/%`}`
        : null;
    const rows = (await withSkipCache(async () =>
      db
        .selectDistinct({
          model: tokenRecords.model,
          provider: tokenRecords.provider,
        })
        .from(tokenRecords)
        .where(likeCond ? sql`(${uidCond} OR ${likeCond})` : uidCond)
    )) as Array<{ model: string; provider: string }>;
    for (const r of rows) {
      const set = map.get(r.model) ?? new Set<string>();
      set.add(r.provider);
      map.set(r.model, set);
    }
  }
  const result = Array.from(map.entries()).map(([model, providers]) => ({
    model,
    providers: Array.from(providers),
  }));
  remoteModelCache = { at: now, rows: result };
  return result;
}

// 近 30 天有记录（全部来源：本机 + 推送）模型集合 → 默认可见
async function loadRecentActivityModels(): Promise<Set<string>> {
  await initDatabase();
  const cutoff = new Date(Date.now() - RECENT_ACTIVITY_WINDOW_MS).toISOString();
  const rows = (await withSkipCache(async () =>
    db
      .selectDistinct({ model: tokenRecords.model })
      .from(tokenRecords)
      .where(gte(tokenRecords.createdAt, cutoff))
  )) as Array<{ model: string }>;
  return new Set(rows.map((r) => r.model));
}

interface SnapshotPrice {
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
}

function snapshotPriceFor(
  snapshot: ModelsDevSnapshot | null,
  modelsDevId: string
): SnapshotPrice | null {
  if (!snapshot) return null;
  const slash = modelsDevId.indexOf("/");
  if (slash <= 0) return null;
  const providerId = modelsDevId.slice(0, slash);
  const modelId = modelsDevId.slice(slash + 1);
  const model = snapshot.data[providerId]?.models[modelId];
  if (!model?.cost) return null;
  const cost = model.cost;
  return {
    inputPrice: typeof cost.input === "number" ? cost.input : 0,
    outputPrice: typeof cost.output === "number" ? cost.output : 0,
    cacheReadPrice: typeof cost.cache_read === "number" ? cost.cache_read : null,
    cacheWritePrice: typeof cost.cache_write === "number" ? cost.cache_write : null,
  };
}

function samePrice(a: SnapshotPrice | null, b: SnapshotPrice | null): boolean {
  if (!a || !b) return false;
  return (
    a.inputPrice === b.inputPrice &&
    a.outputPrice === b.outputPrice &&
    a.cacheReadPrice === b.cacheReadPrice &&
    a.cacheWritePrice === b.cacheWritePrice
  );
}

export async function getModelPricesList(): Promise<ModelPriceRow[]> {
  const [upstreamModels, priced, snapshot, remoteModels, recentActivity] = await Promise.all([
    loadUpstreamModelRows(),
    loadPricedModels(),
    getSnapshot({ source: await loadModelsDevSource() }),
    loadRemoteModelRows(),
    loadRecentActivityModels(),
  ]);

  const upstreamByModel = new Map<string, string[]>();
  for (const row of upstreamModels) {
    const list = upstreamByModel.get(row.model) ?? [];
    list.push(row.upstreamName);
    upstreamByModel.set(row.model, list);
  }

  const remoteByModel = new Map<string, string[]>();
  for (const row of remoteModels) {
    remoteByModel.set(row.model, row.providers);
  }

  const pricedByModel = new Map<string, (typeof priced)[number]>();
  for (const p of priced) {
    pricedByModel.set(p.model, p);
  }

  // 行集 = upstream models ∪ 已定价 model ∪ 近期推送记录出现过的 model
  const models = new Set<string>([
    ...Array.from(upstreamByModel.keys()),
    ...Array.from(pricedByModel.keys()),
    ...Array.from(remoteByModel.keys()),
  ]);
  const rows: ModelPriceRow[] = [];

  for (const model of Array.from(models).sort((a, b) => a.localeCompare(b))) {
    const price = pricedByModel.get(model);
    const upstreams = upstreamByModel.get(model) ?? [];
    const remoteProviders = remoteByModel.get(model) ?? [];
    const active = upstreams.length > 0;
    const hasRecentActivity = recentActivity.has(model);

    // 自动来源（models.dev / github）：解析 modelsDevId 的 provider 段，显示名优先取快照 name，缺失回退 providerId
    let sourceProvider: string | null = null;
    if ((price?.source === "models.dev" || price?.source === "github") && price.modelsDevId) {
      const slash = price.modelsDevId.indexOf("/");
      if (slash > 0) {
        const providerId = price.modelsDevId.slice(0, slash);
        sourceProvider = snapshot?.data[providerId]?.name ?? providerId;
      }
    }

    let status: ModelPriceRow["status"] = {
      active,
      inactive: !!price && !active,
      pending: false,
      unmatched: false,
      hasUpdate: false,
      removed: false,
      diff: null,
    };

    if (price) {
      if ((price.source === "models.dev" || price.source === "github") && price.modelsDevId) {
        const snapshotPrice = snapshotPriceFor(snapshot, price.modelsDevId);
        if (snapshotPrice) {
          const current: SnapshotPrice = {
            inputPrice: price.inputPrice,
            outputPrice: price.outputPrice,
            cacheReadPrice: price.cacheReadPrice,
            cacheWritePrice: price.cacheWritePrice,
          };
          if (!samePrice(snapshotPrice, current)) {
            status.hasUpdate = true;
            status.diff = {
              inputPrice: snapshotPrice.inputPrice,
              outputPrice: snapshotPrice.outputPrice,
              cacheReadPrice: snapshotPrice.cacheReadPrice,
              cacheWritePrice: snapshotPrice.cacheWritePrice,
            };
          }
        } else {
          status.removed = true;
        }
      }
    } else {
      // 未定价：匹配候选判定待确认/未匹配
      if (snapshot) {
        const { matched, candidates } = matchModelsDevModel(model, snapshot.data);
        const distinct = new Set(
          candidates.map(
            (c) =>
              `${c.inputPrice}|${c.outputPrice}|${c.cacheReadPrice}|${c.cacheWritePrice}`
          )
        );
        if (!matched) {
          status.unmatched = true;
        } else if (candidates.length > 1 && distinct.size > 1) {
          status.pending = true;
        }
      } else {
        status.unmatched = true;
      }
    }

    rows.push({
      model,
      upstreams: [...upstreams, ...remoteProviders],
      inputPrice: price?.inputPrice ?? null,
      outputPrice: price?.outputPrice ?? null,
      cacheReadPrice: price?.cacheReadPrice ?? null,
      cacheWritePrice: price?.cacheWritePrice ?? null,
      source: (price?.source as "models.dev" | "manual") ?? null,
      modelsDevId: price?.modelsDevId ?? null,
      sourceProvider,
      updatedAt: price?.updatedAt ?? null,
      recentActivity: hasRecentActivity,
      status,
    });
  }

  return rows;
}

// 手动编辑价格（source='manual'，清空 models_dev_id）
export async function upsertManualPrice(entry: {
  model: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
}): Promise<void> {
  await initDatabase();
  await withSkipCache(async () => {
    await db
      .insert(modelPricesTable)
      .values({
        model: entry.model,
        inputPrice: entry.inputPrice,
        outputPrice: entry.outputPrice,
        cacheReadPrice: entry.cacheReadPrice,
        cacheWritePrice: entry.cacheWritePrice,
        source: "manual",
        modelsDevId: null,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: modelPricesTable.model,
        set: {
          inputPrice: entry.inputPrice,
          outputPrice: entry.outputPrice,
          cacheReadPrice: entry.cacheReadPrice,
          cacheWritePrice: entry.cacheWritePrice,
          source: "manual",
          modelsDevId: null,
          updatedAt: new Date().toISOString(),
        },
      });
  });
  invalidatePriceCache();
}

// 从候选选定落库（source 取自当前快照，记录 models_dev_id）
export async function selectModelsDevPrice(entry: {
  model: string;
  modelsDevId: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  source: "models.dev" | "github";
}): Promise<void> {
  await initDatabase();
  await withSkipCache(async () => {
    await db
      .insert(modelPricesTable)
      .values({
        model: entry.model,
        inputPrice: entry.inputPrice,
        outputPrice: entry.outputPrice,
        cacheReadPrice: entry.cacheReadPrice,
        cacheWritePrice: entry.cacheWritePrice,
        source: entry.source,
        modelsDevId: entry.modelsDevId,
        updatedAt: new Date().toISOString(),
      })
      .onConflictDoUpdate({
        target: modelPricesTable.model,
        set: {
          inputPrice: entry.inputPrice,
          outputPrice: entry.outputPrice,
          cacheReadPrice: entry.cacheReadPrice,
          cacheWritePrice: entry.cacheWritePrice,
          source: entry.source,
          modelsDevId: entry.modelsDevId,
          updatedAt: new Date().toISOString(),
        },
      });
  });
  invalidatePriceCache();
}

export async function deleteModelPrice(model: string): Promise<boolean> {
  await initDatabase();
  let deleted = false;
  await withSkipCache(async () => {
    const result = await db
      .delete(modelPricesTable)
      .where(eq(modelPricesTable.model, model));
    deleted = Number(result?.changes ?? 0) > 0;
  });
  invalidatePriceCache();
  return deleted;
}

// upsert 写出（force 覆盖模式用）：存在同名行则整体更新（保留手工列的语义见 onConflict）
function upsertPriceRow(price: AutoFillModelPrice) {
  return withSkipCache(async () => {
    await db
      .insert(modelPricesTable)
      .values({
        model: price.model,
        inputPrice: price.inputPrice,
        outputPrice: price.outputPrice,
        cacheReadPrice: price.cacheReadPrice,
        cacheWritePrice: price.cacheWritePrice,
        source: price.source,
        modelsDevId: price.modelsDevId,
        updatedAt: price.updatedAt,
      })
      .onConflictDoUpdate({
        target: modelPricesTable.model,
        set: {
          inputPrice: price.inputPrice,
          outputPrice: price.outputPrice,
          cacheReadPrice: price.cacheReadPrice,
          cacheWritePrice: price.cacheWritePrice,
          source: price.source,
          modelsDevId: price.modelsDevId,
          updatedAt: price.updatedAt,
        },
      });
  });
}

// 批量自动填充所有未定价行（只填空不覆盖；无快照时跳过全部）
export async function autoFillAllUnpriced(): Promise<{
  filled: string[];
  updated: string[];
  skipped: string[];
  unmatched: string[];
}> {
  await initDatabase();
  const [upstreamModels, priced] = await Promise.all([
    loadUpstreamModelRows(),
    loadPricedModels(),
  ]);
  const source = await loadModelsDevSource();
  const snapshot = await getSnapshot({ source });
  const pricedSet = new Set(priced.map((p) => p.model));
  const models = Array.from(
    new Set(upstreamModels.map((r) => r.model))
  );

  const result = await autoFillModelPrices(models, {
    snapshot,
    isPriced: (m) => pricedSet.has(m),
    write: upsertPriceRow,
  });
  if (result.filled.length > 0) invalidatePriceCache();
  return result;
}

// 强制重填：覆盖所有非 manual 已定价行（skip manual），填未定价行。
// manual 保护集：loadPricedModels 中 source='manual' 的行；write 一律 upsert。
export async function autoFillForceAll(): Promise<{
  filled: string[];
  updated: string[];
  skipped: string[];
  unmatched: string[];
}> {
  await initDatabase();
  const [upstreamModels, priced] = await Promise.all([
    loadUpstreamModelRows(),
    loadPricedModels(),
  ]);
  const source = await loadModelsDevSource();
  const snapshot = await getSnapshot({ source });
  const manualSet = new Set(
    priced.filter((p) => p.source === "manual").map((p) => p.model)
  );
  const pricedSet = new Set(priced.map((p) => p.model));
  const models = Array.from(
    new Set([
      ...upstreamModels.map((r) => r.model),
      ...priced.filter((p) => p.source !== "manual").map((p) => p.model),
    ])
  );

  const result = await autoFillModelPrices(models, {
    snapshot,
    overwrite: true,
    isPriced: (m) => pricedSet.has(m),
    isManual: (m) => manualSet.has(m),
    write: upsertPriceRow,
  });
  if (result.filled.length > 0 || result.updated.length > 0) {
    invalidatePriceCache();
  }
  return result;
}

// upstream 保存后 best-effort 填充新增 model（失败静默，不阻塞保存）
export async function autoFillForModels(models: string[]): Promise<void> {
  try {
    await initDatabase();
    const [priced, snapshot] = await Promise.all([
      loadPricedModels(),
      getSnapshot({ source: await loadModelsDevSource() }),
    ]);
    const pricedSet = new Set(priced.map((p) => p.model));
    const result = await autoFillModelPrices(models, {
      snapshot,
      isPriced: (m) => pricedSet.has(m),
      write: upsertPriceRow,
    });
    if (result.filled.length > 0) invalidatePriceCache();
  } catch (err) {
    console.warn("[model-prices] auto-fill failed:", err);
  }
}
