/**
 * Provider Anonymization Utilities
 *
 * Reads HIDDEN_PROVIDERS from environment and provides functions to
 * anonymize/deanonymize provider names for the dashboard UI.
 *
 * Supports three formats:
 *
 * 1. Legacy format (no semicolons or colons): comma-separated exact matches
 *    HIDDEN_PROVIDERS="openai,anthropic"
 *    → Each provider maps to "Provider A", "Provider B" by original order.
 *
 * 2. Anonymous grouped format (with semicolons): semicolon-separated groups,
 *    each group contains comma-separated patterns (exact or wildcard with *)
 *    HIDDEN_PROVIDERS="name1*,name2*;name3,name4*"
 *    → Group 1 → "Provider A", Group 2 → "Provider B", etc.
 *    → Multiple real providers can match the same group (many-to-one mapping).
 *
 * 3. Named grouped format (with colons): each group can specify a custom
 *    display name followed by a colon
 *    HIDDEN_PROVIDERS="Bailian:ExampleProvider,ExampleProvider-Bailian;Bedrock:ExampleProvider-Bedrock"
 *    → Group 1 → "Bailian", Group 2 → "Bedrock"
 *    → Multiple real providers can match the same group (many-to-one mapping).
 */

export interface HiddenProviderGroup {
  name: string; // display name, e.g. "Bailian" or "Provider A"
  letter: string; // "A", "B", ... (auto-generated, kept for compatibility)
  patterns: string[]; // ["name1*", "name2*"]
}

function isGroupedFormat(raw: string): boolean {
  return raw.includes(";") || raw.includes(":");
}

/**
 * Parses the HIDDEN_PROVIDERS environment variable into groups.
 *
 * Grouped format: "name1*,name2*;name3,name4*"
 *   - Semicolons separate groups
 *   - Commas separate patterns within a group
 *   - Asterisk suffix means prefix match
 *
 * Named grouped format: "Bailian:ExampleProvider,ExampleProvider-Bailian;Bedrock:ExampleProvider-Bedrock"
 *   - Colon separates the custom display name from its patterns
 *   - If a group has no custom name, it falls back to "Provider A/B/C..."
 *
 * Legacy format (no semicolons or colons) returns a single group with all patterns.
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

  return groups.map((group, index) => {
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

/**
 * Legacy function: returns a flat list of hidden provider names/patterns.
 *
 * For grouped format, returns all patterns flattened.
 * For legacy format, returns comma-separated values.
 */
export function getHiddenProviders(): string[] {
  const raw = process.env.HIDDEN_PROVIDERS;
  if (!raw || raw.trim() === "") {
    return [];
  }

  if (isGroupedFormat(raw)) {
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
 * - If hidden, maps to the group's display name (custom name or "Provider A/B/...").
 */
export function anonymizeProvider(
  provider: string,
  _allProviders: string[]
): string {
  const raw = process.env.HIDDEN_PROVIDERS || "";

  if (!raw.trim()) {
    return provider;
  }

  if (isGroupedFormat(raw)) {
    // Grouped format: match against groups in order
    const groups = getHiddenProviderGroups();
    for (const group of groups) {
      if (group.patterns.some((pattern) => matchesPattern(provider, pattern))) {
        return group.name;
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
 * Resolves a display name to the list of matching real provider names.
 *
 * - For grouped format: returns ALL providers matching the group's patterns.
 * - For legacy format: returns providers matching the pattern at the given letter index.
 *
 * @param displayName - The display name (e.g. "Bailian", "Provider A" or "google")
 * @param allProviders - Complete list of real provider names in the database
 * @returns Array of matching real provider names
 */
export function resolveProviderFilter(
  displayName: string,
  allProviders: string[]
): string[] {
  const raw = process.env.HIDDEN_PROVIDERS || "";

  if (!raw.trim()) {
    // No hidden providers configured — the name IS the real name
    return allProviders.includes(displayName) ? [displayName] : [];
  }

  if (isGroupedFormat(raw)) {
    // Grouped format: find the group by display name
    const groups = getHiddenProviderGroups();
    const group = groups.find((g) => g.name === displayName);
    if (!group) {
      // Not a configured display name — treat as real provider name
      return allProviders.includes(displayName) ? [displayName] : [];
    }

    return allProviders.filter((provider) =>
      group.patterns.some((pattern) => matchesPattern(provider, pattern))
    );
  }

  // Legacy format: match by pattern, return all matching providers
  const match = displayName.match(/^Provider ([A-Z])$/);
  if (!match) {
    return allProviders.includes(displayName) ? [displayName] : [];
  }

  const letter = match[1];
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
