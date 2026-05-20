// Model 归一化工具函数
// 通过 MODEL_RULES 将不同版本的同一模型合并为统一名称

export const TOP_N_RAW_MODELS = 20;
export const TOP_N_DISPLAY = 5;

const MODEL_RULES: Array<[string, string]> = [
  // 规则按优先级排序，排在前面的优先匹配
  // * 结尾表示前缀匹配，否则为精确匹配

  // Kimi
  ["kimi-k2.6*", "k2p6"],
  ["kimi-k2.5*", "k2p5"],

  // OpenAI（长的放前面，避免误匹配）
  ["gpt-4o-mini*", "gpt-4o-mini"],
  ["gpt-4o*", "gpt-4o"],
  ["gpt-4-turbo*", "gpt-4-turbo"],
  ["gpt-4*", "gpt-4"],

  // Anthropic
  ["claude-3-5-sonnet*", "claude-3.5-sonnet"],
  ["claude-3-5-haiku*", "claude-3.5-haiku"],
  ["claude-3-opus*", "claude-3-opus"],
  ["claude-3-sonnet*", "claude-3-sonnet"],
  ["claude-3-haiku*", "claude-3-haiku"],

  // Google
  ["gemini-1.5-pro*", "gemini-1.5-pro"],
  ["gemini-1.5-flash*", "gemini-1.5-flash"],

  // DeepSeek
  ["deepseek-chat*", "deepseek-v3"],
];

export function normalizeModel(model: string): string {
  for (const [pattern, target] of MODEL_RULES) {
    if (pattern.endsWith("*")) {
      const prefix = pattern.slice(0, -1);
      if (model.startsWith(prefix)) return target;
    } else {
      if (model === pattern) return target;
    }
  }
  return model;
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
function toNum(value: unknown): number {
  if (value === null || value === undefined) return 0;
  if (typeof value === "bigint") return Number(value);
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
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
