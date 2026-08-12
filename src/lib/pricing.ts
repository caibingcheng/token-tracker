import { db, initDatabase, modelPricesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import {
  addToAggregate,
  emptyAggregatedCost,
  finalizeAggregate,
  type AggregatedCost,
  type CostInput,
  type ModelPricing,
} from "@/lib/cost-utils";

// 官方价参考：model_prices 表（model = 发往 upstream 的真实名）。
// 查询时计算，record 不存价格/cost；cache 价 NULL 回退 input_price。

let priceCache: Map<string, ModelPricing> | null = null;

export async function loadPriceMap(): Promise<Map<string, ModelPricing>> {
  if (priceCache) return priceCache;
  await initDatabase();
  let map = new Map<string, ModelPricing>();
  await withSkipCache(async () => {
    const rows = await db.select().from(modelPricesTable);
    map = new Map<string, ModelPricing>();
    for (const row of rows) {
      map.set(row.model, {
        canonicalId: row.model,
        displayName: row.model,
        inputPrice: row.inputPrice,
        cacheReadPrice: row.cacheReadPrice ?? row.inputPrice,
        cacheWritePrice: row.cacheWritePrice ?? row.inputPrice,
        outputPrice: row.outputPrice,
      });
    }
  });
  priceCache = map;
  return map;
}

// 价格/别名变更后清空内存缓存（写接口统一调用）
export function invalidatePriceCache(): void {
  priceCache = null;
}

export interface CostTokens {
  inputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  outputTokens: number;
}

// 按真实 model 名计算单行成本（未定价 → 全 0）
export function computeModelCost(
  model: string,
  tokens: CostTokens,
  priceMap: Map<string, ModelPricing>
): AggregatedCost {
  const input: CostInput = {
    inputTokens: tokens.inputTokens,
    cacheRead: tokens.cacheRead,
    cacheWrite: tokens.cacheWrite,
    outputTokens: tokens.outputTokens,
    pricing: priceMap.get(model) ?? null,
  };
  const agg = emptyAggregatedCost();
  addToAggregate(agg, input);
  return finalizeAggregate(agg);
}
