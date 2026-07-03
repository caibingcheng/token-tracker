import fs from "fs";
import path from "path";
import { type ModelPricing } from "@/lib/cost-utils";
import { toNum } from "@/lib/number-utils";

interface CanonicalInfo {
  displayName: string;
  family?: string;
}

interface ApiModelInfo {
  id: string;
  name: string;
  cost: Record<string, unknown>;
}

interface ProviderModels {
  modelToId: Map<string, string>; // lower-cased local id -> original local id
  info: Map<string, ApiModelInfo>; // lower-cased local id -> info
}

interface Registry {
  canonicalMap: Map<string, CanonicalInfo>;
  priceMap: Map<string, ModelPricing>;
  aliasMap: Map<string, string>;
  canonicalList: string[];
  canonicalModelParts: string[];
  rawToCanonical: Map<string, string>;
  providerModelMap: Map<string, ProviderModels>;
  apiModelInfoMap: Map<string, ApiModelInfo>;
}

const MODELS_JSON_PATH = path.join(
  process.cwd(),
  "public",
  "data",
  "models-dev",
  "models.json"
);
const API_JSON_PATH = path.join(
  process.cwd(),
  "public",
  "data",
  "models-dev",
  "api.json"
);

function getModelPart(canonicalId: string): string {
  const slashIndex = canonicalId.indexOf("/");
  return slashIndex >= 0 ? canonicalId.slice(slashIndex + 1) : canonicalId;
}

function filterAlnum(str: string): string {
  return str.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function longestCommonSubsequenceLength(a: string, b: string): number {
  if (a.length === 0 || b.length === 0) return 0;
  const prev = new Uint16Array(b.length + 1);
  const curr = new Uint16Array(b.length + 1);

  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      if (a[i - 1] === b[j - 1]) {
        curr[j] = prev[j - 1] + 1;
      } else {
        curr[j] = Math.max(prev[j], curr[j - 1]);
      }
    }
    prev.set(curr);
    curr.fill(0);
  }

  return prev[b.length];
}

function loadJsonFile(filePath: string): unknown {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    console.warn(`Failed to load models.dev data from ${filePath}:`, err);
    return null;
  }
}

function buildCanonicalMap(modelsData: unknown): Map<string, CanonicalInfo> {
  const map = new Map<string, CanonicalInfo>();
  if (!modelsData || typeof modelsData !== "object") return map;

  for (const [key, value] of Object.entries(modelsData)) {
    if (!value || typeof value !== "object") continue;
    const info = value as Record<string, unknown>;
    const displayName =
      typeof info.name === "string" && info.name.length > 0
        ? info.name
        : getModelPart(key);
    const family = typeof info.family === "string" ? info.family : undefined;
    map.set(key, { displayName, family });
  }
  return map;
}

function buildPriceMap(
  canonicalMap: Map<string, CanonicalInfo>,
  apiData: unknown
): Map<string, ModelPricing> {
  const priceMap = new Map<string, ModelPricing>();
  if (!apiData || typeof apiData !== "object" || !canonicalMap.size) {
    return priceMap;
  }

  const providers = apiData as Record<string, unknown>;

  canonicalMap.forEach((info, canonicalId) => {
    const modelPart = getModelPart(canonicalId);
    const providerPart = canonicalId.includes("/")
      ? canonicalId.split("/")[0]
      : null;

    let cost: unknown = null;

    // 1. 优先从官方 provider（canonical ID 的前缀）查找
    if (providerPart) {
      const officialProvider = providers[providerPart] as
        | Record<string, unknown>
        | undefined;
      if (officialProvider && officialProvider.models) {
        const models = officialProvider.models as Record<string, unknown>;
        const officialModel =
          models[modelPart] || models[canonicalId];
        if (officialModel && typeof officialModel === "object") {
          cost = (officialModel as Record<string, unknown>).cost;
        }
      }
    }

    // 2. Fallback：扫描任意 provider
    if (!cost || typeof cost !== "object") {
      for (const provider of Object.values(providers)) {
        if (!provider || typeof provider !== "object") continue;
        const models = (provider as Record<string, unknown>).models as
          | Record<string, unknown>
          | undefined;
        if (!models) continue;

        const modelEntry =
          models[canonicalId] || models[modelPart];
        if (modelEntry && typeof modelEntry === "object") {
          const candidateCost = (modelEntry as Record<string, unknown>).cost;
          if (candidateCost && typeof candidateCost === "object") {
            cost = candidateCost;
            break;
          }
        }
      }
    }

    if (!cost || typeof cost !== "object") return;

    const costObj = cost as Record<string, unknown>;
    const inputPrice = toNum(costObj.input);
    const outputPrice = toNum(costObj.output);
    if (inputPrice === 0 && outputPrice === 0 && toNum(costObj.cache_read) === 0) {
      // 没有可用价格信息，不加入 price map，cost 将显示为 0
      return;
    }

    const cacheReadPrice =
      costObj.cache_read !== undefined
        ? toNum(costObj.cache_read)
        : inputPrice;
    const cacheWritePrice =
      costObj.cache_write !== undefined
        ? toNum(costObj.cache_write)
        : inputPrice;

    priceMap.set(canonicalId, {
      canonicalId,
      displayName: info.displayName,
      inputPrice,
      cacheReadPrice,
      cacheWritePrice,
      outputPrice,
    });
  });

  return priceMap;
}

function buildAliasMap(
  canonicalMap: Map<string, CanonicalInfo>,
  apiData: unknown
): Map<string, string> {
  const aliasMap = new Map<string, string>();
  if (!apiData || typeof apiData !== "object") return aliasMap;

  const providers = apiData as Record<string, unknown>;

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as Record<string, unknown>).models as
      | Record<string, unknown>
      | undefined;
    if (!models) continue;

    for (const [localId, modelEntry] of Object.entries(models)) {
      if (!modelEntry || typeof modelEntry !== "object") continue;
      const entry = modelEntry as Record<string, unknown>;

      const candidates: string[] = [localId];
      const entryId = typeof entry.id === "string" ? entry.id : null;
      if (entryId && entryId !== localId) {
        candidates.push(entryId);
      }

      for (const candidate of candidates) {
        const lower = candidate.toLowerCase();
        if (aliasMap.has(lower)) continue;

        // 直接等于 canonical ID
        if (canonicalMap.has(lower)) {
          aliasMap.set(lower, lower);
          continue;
        }

        // 等于某个 canonical 的 model 部分
        for (const canonicalId of Array.from(canonicalMap.keys())) {
          if (getModelPart(canonicalId).toLowerCase() === lower) {
            aliasMap.set(lower, canonicalId);
            break;
          }
        }
      }

      // 同时记录 provider-local 组合形式：providerId/localId
      const combo = `${providerId}/${localId}`.toLowerCase();
      if (!aliasMap.has(combo) && canonicalMap.has(combo)) {
        aliasMap.set(combo, combo);
      }
    }
  }

  // 确保 canonical ID 自身也在 alias map 中
  for (const canonicalId of Array.from(canonicalMap.keys())) {
    const lower = canonicalId.toLowerCase();
    if (!aliasMap.has(lower)) {
      aliasMap.set(lower, canonicalId);
    }
  }

  return aliasMap;
}

function buildProviderModelMap(
  apiData: unknown
): {
  providerModelMap: Map<string, ProviderModels>;
  apiModelInfoMap: Map<string, ApiModelInfo>;
} {
  const providerModelMap = new Map<string, ProviderModels>();
  const apiModelInfoMap = new Map<string, ApiModelInfo>();
  if (!apiData || typeof apiData !== "object") {
    return { providerModelMap, apiModelInfoMap };
  }

  const providers = apiData as Record<string, unknown>;

  for (const [providerId, provider] of Object.entries(providers)) {
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as Record<string, unknown>).models as
      | Record<string, unknown>
      | undefined;
    if (!models) continue;

    const modelToId = new Map<string, string>();
    const info = new Map<string, ApiModelInfo>();

    for (const [localId, modelEntry] of Object.entries(models)) {
      if (!modelEntry || typeof modelEntry !== "object") continue;
      const entry = modelEntry as Record<string, unknown>;

      const name =
        typeof entry.name === "string" && entry.name.length > 0
          ? entry.name
          : localId;
      const cost =
        entry.cost && typeof entry.cost === "object"
          ? (entry.cost as Record<string, unknown>)
          : {};

      const lower = localId.toLowerCase();
      const apiInfo: ApiModelInfo = { id: localId, name, cost };
      if (!modelToId.has(lower)) {
        modelToId.set(lower, localId);
        info.set(lower, apiInfo);
      }
      if (!apiModelInfoMap.has(lower)) {
        apiModelInfoMap.set(lower, apiInfo);
      }
    }

    if (modelToId.size > 0) {
      providerModelMap.set(providerId.toLowerCase(), { modelToId, info });
    }
  }

  return { providerModelMap, apiModelInfoMap };
}
function loadRegistry(): Registry {
  const modelsData = loadJsonFile(MODELS_JSON_PATH);
  const apiData = loadJsonFile(API_JSON_PATH);

  const canonicalMap = buildCanonicalMap(modelsData);
  const priceMap = buildPriceMap(canonicalMap, apiData);
  const aliasMap = buildAliasMap(canonicalMap, apiData);
  const { providerModelMap, apiModelInfoMap } = buildProviderModelMap(apiData);
  const canonicalList = Array.from(canonicalMap.keys());
  const canonicalModelParts = canonicalList.map((id) => filterAlnum(getModelPart(id)));

  return {
    canonicalMap,
    priceMap,
    aliasMap,
    providerModelMap,
    apiModelInfoMap,
    canonicalList,
    canonicalModelParts,
    rawToCanonical: new Map(),
  };
}

function loadPriceRules(reg: Registry): Map<string, ModelPricing> {
  const raw = process.env.PRICE_RULES;
  const map = new Map<string, ModelPricing>();
  if (!raw || raw.trim() === "") return map;

  const rules = raw.split(",").map((r) => r.trim()).filter(Boolean);
  for (const rule of rules) {
    const parts = rule.split(":");
    if (parts.length !== 5) continue;
    const [canonicalId, input, cacheRead, cacheWrite, output] = parts.map((part) => part.trim());
    if (!canonicalId) continue;

    const info = reg.canonicalMap.get(canonicalId);
    map.set(canonicalId, {
      canonicalId,
      displayName: info?.displayName || getModelPart(canonicalId),
      inputPrice: toNum(input),
      cacheReadPrice: toNum(cacheRead),
      cacheWritePrice: toNum(cacheWrite),
      outputPrice: toNum(output),
    });
  }

  return map;
}

function applyPriceOverrides(reg: Registry): void {
  const overrides = loadPriceRules(reg);
  overrides.forEach((pricing, canonicalId) => {
    reg.priceMap.set(canonicalId, pricing);
  });
}

let registry: Registry | null = null;

function ensureRegistry(): Registry {
  if (!registry) {
    registry = loadRegistry();
    applyPriceOverrides(registry);
  }
  return registry;
}

export function getRegistry(): Registry {
  return ensureRegistry();
}

/**
 * 仅在 canonical / alias / LCS 中查找最佳匹配，不触碰 api.json。
 * 用于把 api.json 命中的 model 进一步归一化到 canonical（如果可能）。
 */
function resolveApiModelToCanonical(
  apiInfo: ApiModelInfo,
  reg: Registry
): string | null {
  const targetFiltered = filterAlnum(apiInfo.name);
  if (targetFiltered.length === 0) return null;

  let result: string | null = null;

  // 优先按 display name 的 alnum 完全匹配 canonical 模型
  reg.canonicalMap.forEach((info, canonicalId) => {
    if (result) return;
    if (filterAlnum(info.displayName) === targetFiltered) {
      result = canonicalId;
    }
  });

  if (result) return result;

  // 兜底：用 LCS，但阈值收紧到 0.9，避免短串/高重叠误匹配
  let bestRatio = 0;
  let bestId = "";

  for (let i = 0; i < reg.canonicalList.length; i++) {
    const candidatePart = reg.canonicalModelParts[i];
    const lcs = longestCommonSubsequenceLength(targetFiltered, candidatePart);
    const ratio = lcs / targetFiltered.length;
    if (ratio > bestRatio) {
      bestRatio = ratio;
      bestId = reg.canonicalList[i];
    }
  }

  if (bestRatio >= 0.9 && bestId) {
    return bestId;
  }

  return null;
}

export function normalizeModel(raw: string, provider?: string): string {
  if (!raw || typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  const reg = ensureRegistry();

  // 记忆化缓存（key 包含 provider，因为相同 model 在不同 provider 下可能归一化结果不同）
  const cacheKey = provider ? `${provider}:${trimmed}` : trimmed;
  const cached = reg.rawToCanonical.get(cacheKey);
  if (cached !== undefined) return cached;

  const lower = trimmed.toLowerCase();
  const providerTrimmed = provider ? provider.trim() : undefined;

  // 1. 精确匹配 canonical ID
  if (reg.canonicalMap.has(lower)) {
    reg.rawToCanonical.set(cacheKey, lower);
    return lower;
  }

  // 2. 精确匹配 provider-local alias（ canonical 模型在 api.json 中的别名映射）
  const aliased = reg.aliasMap.get(lower);
  if (aliased) {
    reg.rawToCanonical.set(cacheKey, aliased);
    return aliased;
  }

  // 3. provider 精确匹配 api.json（处理不在 canonical 中的 provider-specific 模型）
  if (providerTrimmed) {
    const providerLower = providerTrimmed.toLowerCase();
    const providerModels = reg.providerModelMap.get(providerLower);
    if (providerModels) {
      const matchedId = providerModels.modelToId.get(lower);
      if (matchedId) {
        const apiInfo = providerModels.info.get(lower);
        const canonicalMatch = apiInfo
          ? resolveApiModelToCanonical(apiInfo, reg)
          : null;
        const result = canonicalMatch || matchedId;
        reg.rawToCanonical.set(cacheKey, result);
        return result;
      }
    }
  }

  // 4. 全局 api.json model 名称匹配（不限制 provider，用于自部署等未命中 provider 的场景）
  const globalApiInfo = reg.apiModelInfoMap.get(lower);
  if (globalApiInfo) {
    const canonicalMatch = resolveApiModelToCanonical(globalApiInfo, reg);
    const result = canonicalMatch || globalApiInfo.id;
    reg.rawToCanonical.set(cacheKey, result);
    return result;
  }

  // 5. 子序列模糊匹配
  const rawFiltered = filterAlnum(trimmed);
  if (rawFiltered.length > 0) {
    let bestRatio = 0;
    let bestId = "";

    for (let i = 0; i < reg.canonicalList.length; i++) {
      const candidatePart = reg.canonicalModelParts[i];
      const lcs = longestCommonSubsequenceLength(rawFiltered, candidatePart);
      const ratio = lcs / rawFiltered.length;
      if (ratio > bestRatio) {
        bestRatio = ratio;
        bestId = reg.canonicalList[i];
      }
    }

    if (bestRatio >= 0.6 && bestId) {
      reg.rawToCanonical.set(cacheKey, bestId);
      return bestId;
    }
  }

  // 6. Fallback：保持原始名称
  reg.rawToCanonical.set(cacheKey, trimmed);
  return trimmed;
}

export function getDisplayName(canonicalId: string): string {
  const reg = ensureRegistry();
  const info = reg.canonicalMap.get(canonicalId);
  if (info?.displayName) return info.displayName;

  const apiInfo = reg.apiModelInfoMap.get(canonicalId.toLowerCase());
  if (apiInfo?.name) return apiInfo.name;

  return getModelPart(canonicalId);
}

export function getShortDisplayName(canonicalId: string): string {
  return getModelPart(canonicalId);
}

export function getPricing(canonicalId: string): ModelPricing | null {
  const reg = ensureRegistry();
  const existing = reg.priceMap.get(canonicalId);
  if (existing) return existing;

  const apiInfo = reg.apiModelInfoMap.get(canonicalId.toLowerCase());
  if (!apiInfo) return null;

  const cost = apiInfo.cost;
  const inputPrice = toNum(cost.input);
  const outputPrice = toNum(cost.output);
  const cacheReadPrice =
    cost.cache_read !== undefined
      ? toNum(cost.cache_read)
      : inputPrice;
  const cacheWritePrice =
    cost.cache_write !== undefined
      ? toNum(cost.cache_write)
      : inputPrice;

  if (
    inputPrice === 0 &&
    outputPrice === 0 &&
    cacheReadPrice === 0 &&
    cacheWritePrice === 0
  ) {
    return null;
  }

  return {
    canonicalId,
    displayName: apiInfo.name || getModelPart(canonicalId),
    inputPrice,
    cacheReadPrice,
    cacheWritePrice,
    outputPrice,
  };
}
