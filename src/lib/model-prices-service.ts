import { eq } from "drizzle-orm";
import { db, initDatabase, modelPricesTable, upstreamsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { parseEnabledModels } from "@/lib/gateway/model-router";
import { getSnapshot, type ModelsDevSnapshot } from "@/lib/models-dev/snapshot";
import { matchModelsDevModel } from "@/lib/models-dev/match";
import { autoFillModelPrices } from "@/lib/models-dev/auto-fill";
import { invalidatePriceCache } from "@/lib/pricing";

// model_prices 管理服务层：行集 = 全部 upstream enabled_models（非通配，去重）
// ∪ 已定价 model，附徽标状态判定（active/inactive/待确认/未匹配/有更新/已下架）。

export interface ModelPriceRow {
  model: string;
  upstreams: string[];
  inputPrice: number | null;
  outputPrice: number | null;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  source: "models.dev" | "manual" | null;
  modelsDevId: string | null;
  updatedAt: string | null;
  status: {
    active: boolean;
    inactive: boolean;
    pending: boolean; // 未定价且候选 >1 且价格不一致
    unmatched: boolean; // 未定价且无候选
    hasUpdate: boolean; // source=models.dev 且快照同 id 价格不同
    removed: boolean; // source=models.dev 且快照无该 id
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
  const [upstreamModels, priced, snapshot] = await Promise.all([
    loadUpstreamModelRows(),
    loadPricedModels(),
    getSnapshot(),
  ]);

  const upstreamByModel = new Map<string, string[]>();
  for (const row of upstreamModels) {
    const list = upstreamByModel.get(row.model) ?? [];
    list.push(row.upstreamName);
    upstreamByModel.set(row.model, list);
  }

  const pricedByModel = new Map<string, (typeof priced)[number]>();
  for (const p of priced) {
    pricedByModel.set(p.model, p);
  }

  // 行集 = upstream models ∪ 已定价 model
  const models = new Set<string>([
    ...Array.from(upstreamByModel.keys()),
    ...Array.from(pricedByModel.keys()),
  ]);
  const rows: ModelPriceRow[] = [];

  for (const model of Array.from(models).sort((a, b) => a.localeCompare(b))) {
    const price = pricedByModel.get(model);
    const upstreams = upstreamByModel.get(model) ?? [];
    const active = upstreams.length > 0;

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
      if (price.source === "models.dev" && price.modelsDevId) {
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
      upstreams,
      inputPrice: price?.inputPrice ?? null,
      outputPrice: price?.outputPrice ?? null,
      cacheReadPrice: price?.cacheReadPrice ?? null,
      cacheWritePrice: price?.cacheWritePrice ?? null,
      source: (price?.source as "models.dev" | "manual") ?? null,
      modelsDevId: price?.modelsDevId ?? null,
      updatedAt: price?.updatedAt ?? null,
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

// 从候选选定落库（source='models.dev'，记录 models_dev_id）
export async function selectModelsDevPrice(entry: {
  model: string;
  modelsDevId: string;
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
        source: "models.dev",
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
          source: "models.dev",
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

// 批量自动填充所有未定价行（只填空不覆盖；无快照时跳过全部）
export async function autoFillAllUnpriced(): Promise<{
  filled: string[];
  skipped: string[];
  unmatched: string[];
}> {
  const [upstreamModels, priced, snapshot] = await Promise.all([
    loadUpstreamModelRows(),
    loadPricedModels(),
    getSnapshot(),
  ]);
  const pricedSet = new Set(priced.map((p) => p.model));
  const models = Array.from(
    new Set(upstreamModels.map((r) => r.model))
  );

  const result = await autoFillModelPrices(models, {
    snapshot,
    isPriced: (m) => pricedSet.has(m),
    write: async (price) => {
      await withSkipCache(async () => {
        await db.insert(modelPricesTable).values({
          model: price.model,
          inputPrice: price.inputPrice,
          outputPrice: price.outputPrice,
          cacheReadPrice: price.cacheReadPrice,
          cacheWritePrice: price.cacheWritePrice,
          source: "models.dev",
          modelsDevId: price.modelsDevId,
          updatedAt: price.updatedAt,
        });
      });
    },
  });
  if (result.filled.length > 0) invalidatePriceCache();
  return result;
}

// upstream 保存后 best-effort 填充新增 model（失败静默，不阻塞保存）
export async function autoFillForModels(models: string[]): Promise<void> {
  try {
    await initDatabase();
    const [priced, snapshot] = await Promise.all([loadPricedModels(), getSnapshot()]);
    const pricedSet = new Set(priced.map((p) => p.model));
    const result = await autoFillModelPrices(models, {
      snapshot,
      isPriced: (m) => pricedSet.has(m),
      write: async (price) => {
        await withSkipCache(async () => {
          await db.insert(modelPricesTable).values({
            model: price.model,
            inputPrice: price.inputPrice,
            outputPrice: price.outputPrice,
            cacheReadPrice: price.cacheReadPrice,
            cacheWritePrice: price.cacheWritePrice,
            source: "models.dev",
            modelsDevId: price.modelsDevId,
            updatedAt: price.updatedAt,
          });
        });
      },
    });
    if (result.filled.length > 0) invalidatePriceCache();
  } catch (err) {
    console.warn("[model-prices] auto-fill failed:", err);
  }
}
