import fs from "fs";
import path from "path";
import { type ModelPricing } from "@/lib/cost-utils";
import { toNum } from "@/lib/number-utils";

interface CanonicalInfo {
  displayName: string;
  family?: string;
}

interface Registry {
  canonicalMap: Map<string, CanonicalInfo>;
  priceMap: Map<string, ModelPricing>;
  aliasMap: Map<string, string>;
  canonicalList: string[];
  canonicalModelParts: string[];
  rawToCanonical: Map<string, string>;
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

function loadRegistry(): Registry {
  const modelsData = loadJsonFile(MODELS_JSON_PATH);
  const apiData = loadJsonFile(API_JSON_PATH);

  const canonicalMap = buildCanonicalMap(modelsData);
  const priceMap = buildPriceMap(canonicalMap, apiData);
  const aliasMap = buildAliasMap(canonicalMap, apiData);
  const canonicalList = Array.from(canonicalMap.keys());
  const canonicalModelParts = canonicalList.map((id) => filterAlnum(getModelPart(id)));

  return {
    canonicalMap,
    priceMap,
    aliasMap,
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

export function normalizeModel(raw: string): string {
  if (!raw || typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  const reg = ensureRegistry();

  // 记忆化缓存
  const cached = reg.rawToCanonical.get(trimmed);
  if (cached !== undefined) return cached;

  const lower = trimmed.toLowerCase();

  // 1. 精确匹配 canonical ID
  if (reg.canonicalMap.has(lower)) {
    reg.rawToCanonical.set(trimmed, lower);
    return lower;
  }

  // 2. 精确匹配 provider-local alias
  const aliased = reg.aliasMap.get(lower);
  if (aliased) {
    reg.rawToCanonical.set(trimmed, aliased);
    return aliased;
  }

  // 3. 子序列模糊匹配
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
      reg.rawToCanonical.set(trimmed, bestId);
      return bestId;
    }
  }

  // 4. Fallback：保持原始名称
  reg.rawToCanonical.set(trimmed, trimmed);
  return trimmed;
}

export function getDisplayName(canonicalId: string): string {
  const info = ensureRegistry().canonicalMap.get(canonicalId);
  if (info?.displayName) return info.displayName;
  return getModelPart(canonicalId);
}

export function getShortDisplayName(canonicalId: string): string {
  return getModelPart(canonicalId);
}

export function getPricing(canonicalId: string): ModelPricing | null {
  return ensureRegistry().priceMap.get(canonicalId) || null;
}
