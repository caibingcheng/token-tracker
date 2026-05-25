/**
 * Provider Anonymization Utilities
 *
 * Reads HIDDEN_PROVIDERS from environment and provides functions to
 * anonymize/deanonymize provider names for the dashboard UI.
 *
 * Supports two formats:
 *
 * 1. Legacy format (no semicolons): comma-separated exact matches
 *    HIDDEN_PROVIDERS="openai,anthropic"
 *    → Each provider maps to "Provider A", "Provider B" by original order.
 *
 * 2. Grouped format (with semicolons): semicolon-separated groups, each group
 *    contains comma-separated patterns (exact or wildcard with *)
 *    HIDDEN_PROVIDERS="name1*,name2*;name3,name4*"
 *    → Group 1 → "Provider A", Group 2 → "Provider B", etc.
 *    → Multiple real providers can match the same group (many-to-one mapping).
 */

export interface HiddenProviderGroup {
  letter: string; // "A", "B", ...
  patterns: string[]; // ["name1*", "name2*"]
}

function isNewFormat(raw: string): boolean {
  return raw.includes(";");
}

/**
 * Parses the HIDDEN_PROVIDERS environment variable into groups.
 *
 * New format: "name1*,name2*;name3,name4*"
 *   - Semicolons separate groups
 *   - Commas separate patterns within a group
 *   - Asterisk suffix means prefix match
 *
 * Legacy format (no semicolons) returns a single group with all patterns.
 */
export function getHiddenProviderGroups(): HiddenProviderGroup[] {
  const raw = process.env.HIDDEN_PROVIDERS;
  if (!raw || raw.trim() === "") {
    return [];
  }

  const groups = raw
    .split(";")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);

  return groups.map((group, index) => ({
    letter: String.fromCharCode(65 + index), // A, B, C...
    patterns: group
      .split(",")
      .map((p) => p.trim())
      .filter((p) => p.length > 0),
  }));
}

/**
 * Legacy function: returns a flat list of hidden provider names/patterns.
 *
 * For new format, returns all patterns flattened.
 * For legacy format, returns comma-separated values.
 */
export function getHiddenProviders(): string[] {
  const raw = process.env.HIDDEN_PROVIDERS;
  if (!raw || raw.trim() === "") {
    return [];
  }

  if (isNewFormat(raw)) {
    const groups = getHiddenProviderGroups();
    return groups.flatMap((g) => g.patterns);
  }

  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
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
 * Returns the anonymized display name for a given provider.
 *
 * - If the provider is NOT hidden, returns the name as-is.
 * - If hidden, maps to "Provider A", "Provider B", etc.
 */
export function anonymizeProvider(
  provider: string,
  _allProviders: string[]
): string {
  const raw = process.env.HIDDEN_PROVIDERS || "";

  if (!raw.trim()) {
    return provider;
  }

  if (isNewFormat(raw)) {
    // New format: match against groups in order
    const groups = getHiddenProviderGroups();
    for (const group of groups) {
      if (group.patterns.some((pattern) => matchesPattern(provider, pattern))) {
        return `Provider ${group.letter}`;
      }
    }
    return provider;
  }

  // Legacy format: match by original order (supports wildcard)
  const hiddenProviders = getHiddenProviders();
  const index = hiddenProviders.findIndex((pattern) =>
    matchesPattern(provider, pattern)
  );
  if (index === -1) {
    return provider;
  }

  return `Provider ${String.fromCharCode(65 + index)}`;
}

/**
 * Resolves an anonymized name to the list of matching real provider names.
 *
 * - For legacy format: returns a single-element array (or empty).
 * - For new format: returns ALL providers matching the group's patterns.
 *
 * @param anonymizedName - The display name (e.g. "Provider A" or "google")
 * @param allProviders - Complete list of real provider names in the database
 * @returns Array of matching real provider names
 */
export function resolveProviderFilter(
  anonymizedName: string,
  allProviders: string[]
): string[] {
  const raw = process.env.HIDDEN_PROVIDERS || "";

  if (!raw.trim()) {
    // No hidden providers configured — the name IS the real name
    return allProviders.includes(anonymizedName) ? [anonymizedName] : [];
  }

  // Check if it's an anonymized name like "Provider A"
  const match = anonymizedName.match(/^Provider ([A-Z])$/);
  if (!match) {
    // Not anonymized — treat as real provider name
    return allProviders.includes(anonymizedName) ? [anonymizedName] : [];
  }

  const letter = match[1];

  if (isNewFormat(raw)) {
    // New format: find the group by letter, return all matching providers
    const groups = getHiddenProviderGroups();
    const group = groups.find((g) => g.letter === letter);
    if (!group) {
      return [];
    }

    return allProviders.filter((provider) =>
      group.patterns.some((pattern) => matchesPattern(provider, pattern))
    );
  }

  // Legacy format: match by pattern, return all matching providers
  const hiddenProviders = getHiddenProviders();
  const index = letter.charCodeAt(0) - 65; // 'A' -> 0, 'B' -> 1, ...

  if (index < 0 || index >= hiddenProviders.length) {
    return [];
  }

  const pattern = hiddenProviders[index];
  return allProviders.filter((provider) => matchesPattern(provider, pattern));
}

/**
 * Legacy backward-compatible function: resolves an anonymized name to a
 * single real provider name.
 *
 * For new format with many-to-one mapping, returns the first match.
 */
export function deanonymizeProvider(
  anonymizedName: string,
  allProviders: string[]
): string | null {
  const results = resolveProviderFilter(anonymizedName, allProviders);
  return results.length > 0 ? results[0] : null;
}
