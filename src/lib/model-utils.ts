import { normalizeModel as registryNormalizeModel, type ModelAliasRule } from "@/lib/model-registry";
import type { HiddenProviderGroup } from "@/lib/provider-utils";
import { toNum } from "@/lib/number-utils";
import type { AggregatedCost } from "@/lib/cost-utils";
import { mergeAggregatedCosts } from "@/lib/cost-utils";

export const TOP_N_RAW_MODELS = 20;
export const TOP_N_DISPLAY = 5;

export function normalizeModel(
  model: string,
  provider?: string,
  groups?: HiddenProviderGroup[],
  aliases: ModelAliasRule[] = []
): string {
  return registryNormalizeModel(model, provider, groups, aliases);
}

export interface StatItem {
  group: string;
  provider?: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  count: number;
  // 该行的成本聚合（按真实 model 名定价计算，stats-query 在分组输出时附加；
  // 归一化聚合时随行合并）
  cost?: AggregatedCost;
}

// PostgreSQL SUM() 返回 bigint，超出 JS Number.MAX_SAFE_INTEGER 时变成字符串
// 需要显式转换为数字避免字符串拼接

/**
 * 将归一化后的 model 名称解析为所有匹配的原始 model 列表。
 *
 * 对 allRawModels 中的每个原始 model 执行 normalizeModel()，
 * 返回所有归一化后等于 normalizedModel 的原始 model 名称。
 */
export function resolveNormalizedModelFilter(
  normalizedModel: string,
  allRawModels: string[],
  providerByModel?: Map<string, string>,
  groups?: HiddenProviderGroup[],
  aliases: ModelAliasRule[] = []
): string[] {
  return allRawModels.filter((raw) => {
    const provider = providerByModel?.get(raw);
    return normalizeModel(raw, provider, groups, aliases) === normalizedModel;
  });
}

export function aggregateByNormalizedModel(
  items: StatItem[],
  groups?: HiddenProviderGroup[],
  aliases: ModelAliasRule[] = []
): StatItem[] {
  const map = new Map<string, StatItem & { costs: AggregatedCost[] }>();

  for (const item of items) {
    const normalized = normalizeModel(item.group, item.provider, groups, aliases);
    const existing = map.get(normalized);

    const base = {
      group: normalized,
      totalInput: toNum(item.totalInput),
      totalOutput: toNum(item.totalOutput),
      totalInputCached: toNum(item.totalInputCached),
      totalInputUncached: toNum(item.totalInputUncached),
      totalCacheWrite: toNum(item.totalCacheWrite),
      count: toNum(item.count),
    };

    if (existing) {
      existing.totalInput += base.totalInput;
      existing.totalOutput += base.totalOutput;
      existing.totalInputCached += base.totalInputCached;
      existing.totalInputUncached += base.totalInputUncached;
      existing.totalCacheWrite += base.totalCacheWrite;
      existing.count += base.count;
      if (item.cost) existing.costs.push(item.cost);
    } else {
      map.set(normalized, {
        ...base,
        costs: item.cost ? [item.cost] : [],
      });
    }
  }

  return Array.from(map.values())
    .map(({ costs, ...rest }) => ({
      ...rest,
      cost: costs.length > 0 ? mergeAggregatedCosts(costs) : undefined,
    }))
    .sort((a, b) => b.totalInput - a.totalInput);
}
