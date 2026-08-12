import type { ModelsDevData, ModelsDevModel } from "./snapshot";

// models.dev 匹配管线：精确 → 归一化 → 日期变体归并。
// 多 provider 同名冲突按原厂优先级表自动预选，全部候选返回供 UI 切换。

export interface PriceCandidate {
  providerId: string;
  providerName: string;
  modelId: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  lastUpdated?: string;
  modelsDevId: string; // `${providerId}/${modelId}`
}

export interface ModelMatchResult {
  matched: PriceCandidate | null;
  candidates: PriceCandidate[];
}

// 内置原厂优先级表（大致的知名度/冲突时倾向顺序），未列入者排最后
export const PRIORITY_PROVIDERS: string[] = [
  "anthropic",
  "openai",
  "google",
  "deepseek",
  "alibaba",
  "qwen",
  "zhipuai",
  "moonshotai",
  "xai",
  "mistral",
  "meta",
];

export function providerPriority(providerId: string): number {
  const idx = PRIORITY_PROVIDERS.indexOf(providerId.toLowerCase());
  return idx === -1 ? PRIORITY_PROVIDERS.length : idx;
}

export function normalizeModelKey(s: string): string {
  return s.toLowerCase().replace(/[-_.]/g, "");
}

// 剥离日期变体后缀：claude-sonnet-4-5-20250929 → claude-sonnet-4-5
export function stripDateVariant(s: string): string {
  return s.replace(/-\d{8}$/, "");
}

function toCandidate(
  providerId: string,
  providerName: string | undefined,
  model: ModelsDevModel
): PriceCandidate {
  const cost = model.cost ?? { input: 0, output: 0 };
  return {
    providerId,
    providerName: providerName ?? providerId,
    modelId: model.id,
    inputPrice: typeof cost.input === "number" ? cost.input : 0,
    outputPrice: typeof cost.output === "number" ? cost.output : 0,
    cacheReadPrice:
      typeof cost.cache_read === "number" ? cost.cache_read : null,
    cacheWritePrice:
      typeof cost.cache_write === "number" ? cost.cache_write : null,
    lastUpdated:
      typeof model.last_updated === "string" ? model.last_updated : undefined,
    modelsDevId: `${providerId}/${model.id}`,
  };
}

function samePrice(a: PriceCandidate, b: PriceCandidate): boolean {
  return (
    a.inputPrice === b.inputPrice &&
    a.outputPrice === b.outputPrice &&
    a.cacheReadPrice === b.cacheReadPrice &&
    a.cacheWritePrice === b.cacheWritePrice
  );
}

export function matchModelsDevModel(
  rawModel: string,
  data: ModelsDevData
): ModelMatchResult {
  const raw = rawModel.trim();
  if (!raw) return { matched: null, candidates: [] };

  const norm = normalizeModelKey(raw);
  const stripped = stripDateVariant(raw);
  const normStripped = normalizeModelKey(stripped);

  const seen = new Map<string, PriceCandidate>(); // modelsDevId → candidate
  const found = new Set<string>();

  // 匹配阶段（依次尝试，一旦命中即收集该阶段全部结果）：
  // 1. 精确匹配 model id
  // 2. 归一化匹配（小写 + 去除 . - _）
  // 3. 日期变体归并（剥离 -\d{8}$ 后缀后重试精确/归一化）
  const stages: Array<(modelId: string) => boolean> = [
    (id) => id === raw,
    (id) => normalizeModelKey(id) === norm,
    (id) => {
      const strippedId = stripDateVariant(id);
      return strippedId === stripped || normalizeModelKey(strippedId) === normStripped;
    },
  ];

  for (const stage of stages) {
    for (const providerId of Object.keys(data)) {
      const provider = data[providerId];
      if (!provider || typeof provider.models !== "object") continue;
      for (const modelId of Object.keys(provider.models)) {
        const model = provider.models[modelId];
        if (!model || typeof model !== "object") continue;
        if (!stage(modelId)) continue;
        found.add(modelId);
        const candidate = toCandidate(providerId, provider.name, model);
        // 同一 provider 下同 id 只保留一个
        seen.set(candidate.modelsDevId, candidate);
      }
    }
    if (found.size > 0) break;
  }

  const candidates = Array.from(seen.values());
  const matched = pickMatched(candidates);
  return { matched, candidates };
}

// 冲突消解：价格不同才视为冲突 → 按优先级取最高；价格相同直接取任一
function pickMatched(candidates: PriceCandidate[]): PriceCandidate | null {
  if (candidates.length === 0) return null;
  const hasConflict = candidates.some((c) => !samePrice(c, candidates[0]));
  if (!hasConflict) return candidates[0];
  return [...candidates].sort(
    (a, b) => providerPriority(a.providerId) - providerPriority(b.providerId)
  )[0];
}

// 搜索模式：全量扫描快照，model id 或 provider 名归一化后包含 query 即命中。
// 与 matchModelsDevModel 不同：不要求名字匹配，供 Price Picker 手动搜索任意条目。
// 命中后按相关性排序再截断（全量收集，避免扫描顺序占满名额导致原厂被聚合平台挤出）：
//   0 = provider 名归一化后精确等于 query（原厂及其全部模型优先）
//   1 = modelId 精确等于 query
//   2 = 归一化后精确等于 query
//   3 = 归一化后以 query 开头（前缀）
//   4 = 归一化后包含 query（子串，兜底）
// 同级按原厂优先级表 + provider id + model id 排序。
export const SEARCH_RESULT_LIMIT = 50;

function searchScore(
  raw: string,
  norm: string,
  providerNorm: string,
  modelId: string
): number {
  if (providerNorm === norm) return 0;
  if (modelId === raw) return 1;
  const mNorm = normalizeModelKey(modelId);
  if (mNorm === norm) return 2;
  if (mNorm.startsWith(norm)) return 3;
  return 4;
}

export function searchModelsDevModel(
  query: string,
  data: ModelsDevData
): PriceCandidate[] {
  const raw = query.trim();
  if (!raw) return [];
  const norm = normalizeModelKey(raw);
  const results: Array<{ score: number; candidate: PriceCandidate }> = [];
  for (const providerId of Object.keys(data)) {
    const provider = data[providerId];
    if (!provider || typeof provider.models !== "object") continue;
    const providerNorm = normalizeModelKey(provider.name ?? providerId);
    for (const modelId of Object.keys(provider.models)) {
      const model = provider.models[modelId];
      if (!model || typeof model !== "object") continue;
      if (
        !normalizeModelKey(modelId).includes(norm) &&
        !providerNorm.includes(norm)
      ) {
        continue;
      }
      results.push({
        score: searchScore(raw, norm, providerNorm, modelId),
        candidate: toCandidate(providerId, provider.name, model),
      });
    }
  }
  results.sort(
    (a, b) =>
      a.score - b.score ||
      providerPriority(a.candidate.providerId) -
        providerPriority(b.candidate.providerId) ||
      a.candidate.providerId.localeCompare(b.candidate.providerId) ||
      a.candidate.modelId.localeCompare(b.candidate.modelId)
  );
  return results.slice(0, SEARCH_RESULT_LIMIT).map((r) => r.candidate);
}

// 构建一次扫描的归一化索引：key = 归一化 model id（含日期变体剥离后的 key），
// 供已定价模型的 provider 推断（比逐模型全表扫描快得多）。
// 同一 key 多个 provider 冲突时保留首个（任意，仅用于分组归属）。
export function buildModelsDevIndex(
  data: ModelsDevData
): Map<string, PriceCandidate> {
  const index = new Map<string, PriceCandidate>();
  for (const providerId of Object.keys(data)) {
    const provider = data[providerId];
    if (!provider || typeof provider.models !== "object") continue;
    for (const modelId of Object.keys(provider.models)) {
      const model = provider.models[modelId];
      if (!model || typeof model !== "object") continue;
      const candidate = toCandidate(providerId, provider.name, model);
      const norm = normalizeModelKey(modelId);
      if (!index.has(norm)) index.set(norm, candidate);
      const stripped = normalizeModelKey(stripDateVariant(modelId));
      if (!index.has(stripped)) index.set(stripped, candidate);
    }
  }
  return index;
}

// 列出单个 provider 的全部模型（PriceSimulatorModal 按 provider 懒加载数据源），
// 按 model id 排序。provider 不存在时返回空数组。
export function listProviderModels(
  data: ModelsDevData,
  providerId: string
): PriceCandidate[] {
  const provider = data[providerId];
  if (!provider || typeof provider.models !== "object") return [];
  const results: PriceCandidate[] = [];
  for (const modelId of Object.keys(provider.models)) {
    const model = provider.models[modelId];
    if (!model || typeof model !== "object") continue;
    results.push(toCandidate(providerId, provider.name, model));
  }
  results.sort((a, b) => a.modelId.localeCompare(b.modelId));
  return results;
}
