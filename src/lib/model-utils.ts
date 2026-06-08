// Model 归一化工具函数
// 通过 MODEL_RULES 将不同版本的同一模型合并为统一名称

export const TOP_N_RAW_MODELS = 20;
export const TOP_N_DISPLAY = 5;

/**
 * 从环境变量 MODEL_RULES 读取规则，格式：
 *   MODEL_RULES="target:pattern,target2:pattern2"
 *
 * 例如：MODEL_RULES="k2p6:kimi-k2.6*,gpt-4o:gpt-4o*"
 *
 * - 逗号分隔规则
 * - 每个规则用冒号分隔 target 和 pattern
 * - target 在前，pattern 在后（与代码中硬编码顺序一致）
 * - * 后缀表示前缀匹配
 *
 * 环境变量规则追加到硬编码规则前面，优先级更高。
 */
function getEnvModelRules(): Array<[string, string]> {
  const raw = process.env.MODEL_RULES;
  if (!raw || raw.trim() === "") {
    return [];
  }

  return raw
    .split(",")
    .map((rule) => {
      const parts = rule.split(":");
      if (parts.length !== 2) return null;
      const [target, pattern] = parts.map((s) => s.trim());
      if (!target || !pattern) return null;
      return [target, pattern] as [string, string];
    })
    .filter((r): r is [string, string] => r !== null);
}

const HARDCODED_MODEL_RULES: Array<[string, string]> = [
  // 规则按优先级排序，排在前面的优先匹配
  // * 结尾表示前缀匹配，否则为精确匹配

  // Kimi
  ["k2p6", "kimi-k2.6*"],
  ["k2p5", "kimi-k2.5*"],

  // OpenAI（长的放前面，避免误匹配）
  ["gpt-4o-mini", "gpt-4o-mini*"],
  ["gpt-4o", "gpt-4o*"],
  ["gpt-4-turbo", "gpt-4-turbo*"],
  ["gpt-4", "gpt-4*"],

  // Anthropic
  ["claude-3.5-sonnet", "claude-3-5-sonnet*"],
  ["claude-3.5-haiku", "claude-3-5-haiku*"],
  ["claude-3-opus", "claude-3-opus*"],
  ["claude-3-sonnet", "claude-3-sonnet*"],
  ["claude-3-haiku", "claude-3-haiku*"],

  // Google
  ["gemini-1.5-pro", "gemini-1.5-pro*"],
  ["gemini-1.5-flash", "gemini-1.5-flash*"],

  // DeepSeek
  ["deepseek-v3", "deepseek-chat*"],
];

// 环境变量规则在前，优先级更高
const ALL_MODEL_RULES: Array<[string, string]> = [
  ...getEnvModelRules(),
  ...HARDCODED_MODEL_RULES,
];

export function normalizeModel(model: string): string {
  for (const [target, pattern] of ALL_MODEL_RULES) {
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
