import type { HiddenProviderGroup } from "@/lib/provider-utils";
import { matchesPattern } from "@/lib/provider-utils";

// 纯归一化模块：不加载任何文件。aliases（归一化规则）由调用方注入，
// 来源为 settings 表 model_aliases（Display pane 编辑）。

// 归一化规则：name = 归一化名（分组 key + UI 展示名），aliases = 匹配别名列表
export interface ModelAliasRule {
  name: string;
  aliases: string[];
}

interface RegistryState {
  rawToCanonical: Map<string, string>;
}

let registry: RegistryState | null = null;

function ensureRegistry(): RegistryState {
  if (!registry) {
    registry = { rawToCanonical: new Map() };
  }
  return registry;
}

export function getRegistry(): RegistryState {
  return ensureRegistry();
}

function getModelPart(canonicalId: string): string {
  const slashIndex = canonicalId.indexOf("/");
  return slashIndex >= 0 ? canonicalId.slice(slashIndex + 1) : canonicalId;
}

function isProviderHidden(
  providerName: string,
  groups: HiddenProviderGroup[]
): boolean {
  return groups.some((group) =>
    group.patterns.some((pattern) => matchesPattern(providerName, pattern))
  );
}

// 清空 normalizeModel 的 rawToCanonical 缓存：
// 当 hidden_providers（settings 表）或 model_aliases 被修改后必须调用，
// 否则旧匿名/归一化映射长期残留
export function invalidateModelCache(): void {
  const reg = registry;
  if (reg) {
    reg.rawToCanonical.clear();
  }
}

export function normalizeModel(
  raw: string,
  provider?: string,
  groups: HiddenProviderGroup[] = [],
  aliases: ModelAliasRule[] = []
): string {
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

  const rules = Array.isArray(aliases) ? aliases : [];

  const setResult = (result: string): string => {
    reg.rawToCanonical.set(cacheKey, result);
    return result;
  };

  // 1. 精确匹配规则 name（归一化名）
  for (const rule of rules) {
    if (rule.name.toLowerCase() === lower) {
      return setResult(rule.name);
    }
  }

  // 2. 精确匹配 provider/model 别名
  if (effectiveProvider) {
    const combo = `${effectiveProvider.toLowerCase()}/${effectiveModel.toLowerCase()}`;
    for (const rule of rules) {
      if (rule.aliases.some((a) => a.toLowerCase().trim() === combo)) {
        return setResult(rule.name);
      }
    }
  }

  // 3. hidden provider fallback：只按 model 部分匹配别名
  if (effectiveProvider && isProviderHidden(effectiveProvider, groups)) {
    const modelOnly = effectiveModel.toLowerCase();
    for (const rule of rules) {
      if (rule.aliases.some((a) => a.toLowerCase().trim() === modelOnly)) {
        return setResult(rule.name);
      }
    }
  }

  // 4. 精确匹配 model 别名
  for (const rule of rules) {
    if (rule.aliases.some((a) => a.toLowerCase().trim() === lower)) {
      return setResult(rule.name);
    }
  }

  // 5. 保持原始名称
  return setResult(trimmed);
}

export function getDisplayName(
  canonicalId: string,
  aliases: ModelAliasRule[] = []
): string {
  const rules = Array.isArray(aliases) ? aliases : [];
  for (const rule of rules) {
    if (rule.name === canonicalId) return rule.name;
  }
  return getModelPart(canonicalId);
}

export function getShortDisplayName(canonicalId: string): string {
  return getModelPart(canonicalId);
}
