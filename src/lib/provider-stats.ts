import { toNum } from "@/lib/number-utils";
import type { StatItem } from "@/lib/model-utils";
import { anonymizeProvider, type HiddenProviderGroup } from "@/lib/provider-utils";
import { mergeAggregatedCosts, type AggregatedCost } from "@/lib/cost-utils";

export interface ProviderStat {
  provider: string;
  providerName: string;
  totalInput: number;
  totalInputCached: number;
  totalOutput: number;
  totalCost: number;
  count: number;
}

// 按 provider（upstream 名，token_records.provider 列）聚合 date-model 行。
// 不截断 Top N，由调用方按需截断；dailyProviders 依赖完整数据供前端 Others 层合并。
export function aggregateProviders(
  rows: Array<StatItem & { group: string; model: string; provider?: string }>,
  groups: HiddenProviderGroup[]
): ProviderStat[] {
  const map = new Map<string, ProviderStat & { costs: AggregatedCost[] }>();

  for (const row of rows) {
    const provider = row.provider ?? "unknown";
    const totalInput = toNum(row.totalInput);
    const totalInputCached = toNum(row.totalInputCached);
    const totalOutput = toNum(row.totalOutput);
    const count = toNum(row.count);
    const existing = map.get(provider);

    if (existing) {
      existing.totalInput += totalInput;
      existing.totalInputCached += totalInputCached;
      existing.totalOutput += totalOutput;
      existing.count += count;
      if (row.cost) existing.costs.push(row.cost);
    } else {
      map.set(provider, {
        provider,
        providerName: anonymizeProvider(provider, [], groups),
        totalInput,
        totalInputCached,
        totalOutput,
        totalCost: 0,
        count,
        costs: row.cost ? [row.cost] : [],
      });
    }
  }

  return Array.from(map.values())
    .map(({ costs, ...rest }) => ({
      ...rest,
      totalCost: costs.length > 0 ? mergeAggregatedCosts(costs).totalCost : 0,
    }))
    .sort((a, b) => b.totalInput - a.totalInput);
}
