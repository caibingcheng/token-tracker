import { normalizeModel as registryNormalizeModel } from "@/lib/model-registry";
import { toNum } from "@/lib/number-utils";

export const TOP_N_RAW_MODELS = 20;
export const TOP_N_DISPLAY = 5;

export function normalizeModel(model: string): string {
  return registryNormalizeModel(model);
}

export interface StatItem {
  group: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalInputUncached: number;
  totalCacheWrite: number;
  count: number;
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
  allRawModels: string[]
): string[] {
  return allRawModels.filter(
    (raw) => normalizeModel(raw) === normalizedModel
  );
}

export function aggregateByNormalizedModel(items: StatItem[]): StatItem[] {
  const map = new Map<string, StatItem>();

  for (const item of items) {
    const normalized = normalizeModel(item.group);
    const existing = map.get(normalized);

    if (existing) {
      existing.totalInput += toNum(item.totalInput);
      existing.totalOutput += toNum(item.totalOutput);
      existing.totalInputCached += toNum(item.totalInputCached);
      existing.totalInputUncached += toNum(item.totalInputUncached);
      existing.totalCacheWrite += toNum(item.totalCacheWrite);
      existing.count += toNum(item.count);
    } else {
      map.set(normalized, {
        group: normalized,
        totalInput: toNum(item.totalInput),
        totalOutput: toNum(item.totalOutput),
        totalInputCached: toNum(item.totalInputCached),
        totalInputUncached: toNum(item.totalInputUncached),
        totalCacheWrite: toNum(item.totalCacheWrite),
        count: toNum(item.count),
      });
    }
  }

  return Array.from(map.values()).sort(
    (a, b) => b.totalInput - a.totalInput
  );
}
