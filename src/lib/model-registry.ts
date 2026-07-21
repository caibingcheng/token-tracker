import fs from "fs";
import path from "path";
import { type ModelPricing } from "@/lib/cost-utils";
import { toNum } from "@/lib/number-utils";
import { getHiddenProviderGroups, matchesPattern } from "@/lib/provider-utils";

interface CanonicalInfo {
  displayName: string;
}

interface Registry {
  canonicalMap: Map<string, CanonicalInfo>;
  priceMap: Map<string, ModelPricing>;
  aliasMap: Map<string, string>;
  rawToCanonical: Map<string, string>;
}

interface ModelCost {
  input?: unknown;
  output?: unknown;
  cache_read?: unknown;
  cache_write?: unknown;
}

interface ModelEntry {
  name?: unknown;
  cost?: ModelCost;
}

interface ModelRegistryJson {
  version?: unknown;
  models?: Record<string, ModelEntry>;
  aliases?: Record<string, string>;
}

const MODEL_REGISTRY_PATH = path.join(
  process.cwd(),
  "public",
  "data",
  "model-registry.json"
);

function getModelPart(canonicalId: string): string {
  const slashIndex = canonicalId.indexOf("/");
  return slashIndex >= 0 ? canonicalId.slice(slashIndex + 1) : canonicalId;
}

function loadJsonFile(filePath: string): unknown {
  try {
    const content = fs.readFileSync(filePath, "utf-8");
    return JSON.parse(content);
  } catch (err) {
    console.warn(`Failed to load model registry from ${filePath}:`, err);
    return null;
  }
}

function isValidRegistry(data: unknown): data is ModelRegistryJson {
  return (
    data !== null &&
    typeof data === "object" &&
    (!("version" in (data as object)) ||
      typeof (data as ModelRegistryJson).version === "number")
  );
}

function buildCanonicalMap(
  modelsData: Record<string, ModelEntry> | undefined
): Map<string, CanonicalInfo> {
  const map = new Map<string, CanonicalInfo>();
  if (!modelsData || typeof modelsData !== "object") return map;

  for (const [key, value] of Object.entries(modelsData)) {
    if (!value || typeof value !== "object") continue;
    const displayName =
      typeof value.name === "string" && value.name.length > 0
        ? value.name
        : getModelPart(key);
    map.set(key, { displayName });
  }
  return map;
}

function buildPriceMap(
  canonicalMap: Map<string, CanonicalInfo>,
  modelsData: Record<string, ModelEntry> | undefined
): Map<string, ModelPricing> {
  const priceMap = new Map<string, ModelPricing>();
  if (!modelsData || typeof modelsData !== "object" || !canonicalMap.size) {
    return priceMap;
  }

  canonicalMap.forEach((info, canonicalId) => {
    const entry = (modelsData as Record<string, ModelEntry>)[canonicalId];
    if (!entry || typeof entry !== "object") return;

    const cost = entry.cost;
    if (!cost || typeof cost !== "object") return;

    const inputPrice = toNum(cost.input);
    const outputPrice = toNum(cost.output);
    const cacheReadPrice =
      cost.cache_read !== undefined ? toNum(cost.cache_read) : inputPrice;
    const cacheWritePrice =
      cost.cache_write !== undefined ? toNum(cost.cache_write) : inputPrice;

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
  aliasesData: Record<string, string> | undefined
): Map<string, string> {
  const aliasMap = new Map<string, string>();
  if (!aliasesData || typeof aliasesData !== "object") return aliasMap;

  for (const [raw, canonicalId] of Object.entries(aliasesData)) {
    if (typeof canonicalId !== "string") continue;
    const key = raw.toLowerCase().trim();
    if (!key) continue;
    if (!canonicalMap.has(canonicalId)) {
      console.warn(
        `Model alias "${raw}" points to unknown canonical model "${canonicalId}"`
      );
      continue;
    }
    if (!aliasMap.has(key)) {
      aliasMap.set(key, canonicalId);
    }
  }

  return aliasMap;
}

function loadRegistry(): Registry {
  const data = loadJsonFile(MODEL_REGISTRY_PATH);
  const registryData: ModelRegistryJson = isValidRegistry(data)
    ? (data as ModelRegistryJson)
    : {};

  const models =
    registryData.models && typeof registryData.models === "object"
      ? registryData.models
      : {};
  const aliases =
    registryData.aliases && typeof registryData.aliases === "object"
      ? registryData.aliases
      : {};

  const canonicalMap = buildCanonicalMap(models);
  const priceMap = buildPriceMap(canonicalMap, models);
  const aliasMap = buildAliasMap(canonicalMap, aliases);

  return {
    canonicalMap,
    priceMap,
    aliasMap,
    rawToCanonical: new Map(),
  };
}

let registry: Registry | null = null;

function ensureRegistry(): Registry {
  if (!registry) {
    registry = loadRegistry();
  }
  return registry;
}

export function getRegistry(): Registry {
  return ensureRegistry();
}

function isProviderHidden(providerName: string): boolean {
  const groups = getHiddenProviderGroups();
  return groups.some((group) =>
    group.patterns.some((pattern) => matchesPattern(providerName, pattern))
  );
}

export function normalizeModel(raw: string, provider?: string): string {
  if (!raw || typeof raw !== "string") return raw;
  const trimmed = raw.trim();
  if (!trimmed) return raw;

  const reg = ensureRegistry();
  const cacheKey = provider ? `${provider}:${trimmed}` : trimmed;
  const cached = reg.rawToCanonical.get(cacheKey);
  if (cached !== undefined) return cached;

  const lower = trimmed.toLowerCase();
  const providerTrimmed = provider ? provider.trim() : undefined;

  // 从 raw 中提取可能的 provider/model 结构
  const slashIndex = trimmed.indexOf("/");
  const hasRawProvider = slashIndex !== -1;
  const rawProvider = hasRawProvider ? trimmed.slice(0, slashIndex) : undefined;
  const rawModel = hasRawProvider ? trimmed.slice(slashIndex + 1) : trimmed;

  const effectiveProvider = providerTrimmed || rawProvider;
  const effectiveModel = hasRawProvider ? rawModel : trimmed;

  // 1. 精确匹配 canonical ID
  if (reg.canonicalMap.has(lower)) {
    reg.rawToCanonical.set(cacheKey, lower);
    return lower;
  }

  // 2. 精确匹配 provider/model 别名
  if (effectiveProvider) {
    const combo = `${effectiveProvider.toLowerCase()}/${effectiveModel.toLowerCase()}`;
    const aliased = reg.aliasMap.get(combo);
    if (aliased) {
      reg.rawToCanonical.set(cacheKey, aliased);
      return aliased;
    }
  }

  // 3. hidden provider fallback：只按 model 部分匹配别名
  if (effectiveProvider && isProviderHidden(effectiveProvider)) {
    const modelOnly = effectiveModel.toLowerCase();
    const aliased = reg.aliasMap.get(modelOnly);
    if (aliased) {
      reg.rawToCanonical.set(cacheKey, aliased);
      return aliased;
    }
  }

  // 4. 精确匹配 model 别名
  const aliased = reg.aliasMap.get(lower);
  if (aliased) {
    reg.rawToCanonical.set(cacheKey, aliased);
    return aliased;
  }

  // 5. 保持原始名称
  reg.rawToCanonical.set(cacheKey, trimmed);
  return trimmed;
}

export function getDisplayName(canonicalId: string): string {
  const reg = ensureRegistry();
  const info = reg.canonicalMap.get(canonicalId);
  if (info?.displayName) return info.displayName;
  return getModelPart(canonicalId);
}

export function getShortDisplayName(canonicalId: string): string {
  return getModelPart(canonicalId);
}

export function getPricing(canonicalId: string): ModelPricing | null {
  const reg = ensureRegistry();
  return reg.priceMap.get(canonicalId) ?? null;
}
