/**
 * Provider Anonymization Utilities
 *
 * 数据源由调用方显式传入（`loadHiddenProviderGroups()` 唯一 async 入口：
 * settings 表 `hidden_providers` 单一来源，未保存 → 空数组），纯函数不再直接读 env。
 *
 * 支持三种格式（均由 parseHiddenProviderGroups 解析为统一的分组结构，
 * 用于 settings 旧字符串存储值的懒迁移）：
 *
 * 1. Legacy format (no semicolons or colons): comma-separated exact matches
 *    "openai,anthropic"
 *    → 每个 pattern 独立成组，按原始顺序映射 "Provider A" / "Provider B"。
 *
 * 2. Anonymous grouped format (with semicolons): semicolon-separated groups,
 *    each group contains comma-separated patterns (exact or wildcard with *)
 *    "name1*,name2*;name3,name4*"
 *    → Group 1 → "Provider A", Group 2 → "Provider B", etc.
 *    → Multiple real providers can match the same group (many-to-one mapping).
 *
 * 3. Named grouped format (with colons): each group can specify a custom
 *    display name followed by a colon
 *    "CustomA:vendor,vendor-partner;CustomB:vendor-platform"
 *    → Group 1 → "CustomA", Group 2 → "CustomB"
 */

export interface HiddenProviderGroup {
  name: string; // display name, e.g. "CustomA" or "Provider A"
  letter: string; // "A", "B", ... (auto-generated, kept for compatibility)
  patterns: string[]; // ["name1*", "name2*"]
}

function isGroupedFormat(raw: string): boolean {
  return raw.includes(";") || raw.includes(":");
}

/**
 * 纯函数：解析分组语法原始字符串（settings 旧字符串存储值懒迁移用）。不读 env。
 *
 * - 空/纯空白 → []
 * - 分组格式（含 ; 或 :）：分号分组，冒号取名，逗号取 patterns
 * - Legacy 格式：每个逗号分隔的 pattern 独立成组，按序命名 Provider A/B/C...
 *   （保持旧行为：legacy 下每个 provider 获得独立匿名名）
 */
export function parseHiddenProviderGroups(raw: string): HiddenProviderGroup[] {
  if (!raw || raw.trim() === "") {
    return [];
  }

  if (isGroupedFormat(raw)) {
    return raw
      .split(";")
      .map((g) => g.trim())
      .filter((g) => g.length > 0)
      .map((group, index) => {
        const letter = String.fromCharCode(65 + index); // A, B, C...
        const colonIndex = group.indexOf(":");

        let name: string;
        let patternsStr: string;

        if (colonIndex !== -1) {
          name = group.slice(0, colonIndex).trim();
          patternsStr = group.slice(colonIndex + 1);
          if (name.length === 0) {
            name = `Provider ${letter}`;
          }
        } else {
          name = `Provider ${letter}`;
          patternsStr = group;
        }

        return {
          name,
          letter,
          patterns: patternsStr
            .split(",")
            .map((p) => p.trim())
            .filter((p) => p.length > 0),
        };
      });
  }

  // Legacy format: each pattern becomes its own group (Provider A, B, C...)
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0)
    .map((pattern, index) => ({
      name: `Provider ${String.fromCharCode(65 + index)}`,
      letter: String.fromCharCode(65 + index),
      patterns: [pattern],
    }));
}

/**
 * 解析 settings 表存储值（JSON 数组优先，旧字符串语法懒迁移回退）。
 *
 * - null / 空 → []
 * - JSON 数组（每项含 name/patterns，patterns 非空）→ 采用；name 空串补
 *   "Provider A/B/..."，letter 按行序生成
 * - 非法 JSON / 形状不符 → 回退 parseHiddenProviderGroups 旧字符串语法
 */
export function parseStoredHiddenProviderGroups(
  stored: string | null
): HiddenProviderGroup[] {
  if (!stored || stored.trim() === "") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stored);
  } catch {
    return parseHiddenProviderGroups(stored);
  }

  if (!Array.isArray(parsed)) {
    return parseHiddenProviderGroups(stored);
  }

  const groups: HiddenProviderGroup[] = [];
  for (const item of parsed) {
    if (typeof item !== "object" || item === null) {
      return parseHiddenProviderGroups(stored);
    }
    const { name, patterns } = item as Record<string, unknown>;
    if (typeof name !== "string" || !Array.isArray(patterns)) {
      return parseHiddenProviderGroups(stored);
    }
    const cleaned = patterns
      .filter((p): p is string => typeof p === "string" && p.trim() !== "")
      .map((p) => p.trim());
    if (cleaned.length === 0) {
      return parseHiddenProviderGroups(stored);
    }
    const letter = String.fromCharCode(65 + groups.length);
    groups.push({
      name: name.trim() !== "" ? name : `Provider ${letter}`,
      letter,
      patterns: cleaned,
    });
  }
  return groups;
}

/**
 * 合法性校验（PUT 落库前）：数组，每项恰含 name/patterns 两键；
 * patterns 非空数组且元素为非空字符串；name 可为空串（自动命名）。
 */
export function isValidHiddenProviderGroups(
  config: unknown
): config is HiddenProviderGroup[] {
  if (!Array.isArray(config)) return false;
  for (const item of config) {
    if (!item || typeof item !== "object") return false;
    const r = item as Record<string, unknown>;
    for (const key of Object.keys(r)) {
      if (key !== "name" && key !== "patterns") return false;
    }
    if (typeof r.name !== "string") return false;
    if (!Array.isArray(r.patterns) || r.patterns.length === 0) return false;
    for (const p of r.patterns) {
      if (typeof p !== "string" || p.trim() === "") return false;
    }
  }
  return true;
}

/**
 * 唯一 async 入口：settings 表 hidden_providers 单一来源，未保存 → 空数组。
 * 纯函数一律接收解析后的 groups 参数，不直接读 env。
 */
export async function loadHiddenProviderGroups(): Promise<HiddenProviderGroup[]> {
  const { getHiddenProvidersSetting } = await import("@/lib/auth/settings");
  const stored = await getHiddenProvidersSetting();
  if (stored === null) {
    return [];
  }
  return parseStoredHiddenProviderGroups(stored);
}

/**
 * Checks if a provider name matches a pattern.
 *
 * - Pattern ending with "*" → prefix match
 * - Otherwise → exact match
 */
export function matchesPattern(provider: string, pattern: string): boolean {
  if (pattern.endsWith("*")) {
    return provider.startsWith(pattern.slice(0, -1));
  }
  return provider === pattern;
}

/**
 * 返回 provider 对应的归并键（group key）。
 *
 * - 命中某个 hidden provider group → 返回该组的 name（分组显示名）。
 * - 未命中 → 返回原始 provider 名。
 *
 * 用于 provider 维度统计聚合：同组多个真实 provider 合并为同一聚合桶，
 * 组名即展示名与 series dataKey。
 */
export function providerGroupKey(
  provider: string,
  groups: HiddenProviderGroup[]
): string {
  if (groups.length === 0) {
    return provider;
  }
  for (const group of groups) {
    if (group.patterns.some((pattern) => matchesPattern(provider, pattern))) {
      return group.name;
    }
  }
  return provider;
}

/**
 * Returns the anonymized display name for a given provider.
 *
 * - If the provider does NOT match any hidden group, returns the name as-is.
 * - If hidden, maps to the group's display name (custom name or "Provider A/B/...").
 */
export function anonymizeProvider(
  provider: string,
  _allProviders: string[],
  groups: HiddenProviderGroup[]
): string {
  return providerGroupKey(provider, groups);
}

/**
 * Resolves a display name to the list of matching real provider names.
 *
 * - If the display name matches a configured group, returns ALL real providers
 *   matching the group's patterns.
 * - Otherwise treats it as a real provider name.
 *
 * @param displayName - The display name (e.g. "CustomA", "Provider A" or "google")
 * @param allProviders - Complete list of real provider names in the database
 * @param groups - Parsed hidden provider groups (may be empty)
 * @returns Array of matching real provider names
 */
export function resolveProviderFilter(
  displayName: string,
  allProviders: string[],
  groups: HiddenProviderGroup[]
): string[] {
  if (groups.length === 0) {
    // No hidden providers configured — the name IS the real name
    return allProviders.includes(displayName) ? [displayName] : [];
  }

  const group = groups.find((g) => g.name === displayName);
  if (!group) {
    // Not a configured display name — treat as real provider name
    return allProviders.includes(displayName) ? [displayName] : [];
  }

  return allProviders.filter((provider) =>
    group.patterns.some((pattern) => matchesPattern(provider, pattern))
  );
}

/**
 * Legacy backward-compatible function: resolves an anonymized name to a
 * single real provider name.
 *
 * For many-to-one mapping, returns the first match.
 */
export function deanonymizeProvider(
  anonymizedName: string,
  allProviders: string[],
  groups: HiddenProviderGroup[]
): string | null {
  const results = resolveProviderFilter(anonymizedName, allProviders, groups);
  return results.length > 0 ? results[0] : null;
}
