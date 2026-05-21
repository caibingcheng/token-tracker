/**
 * Provider Anonymization Utilities
 *
 * Reads HIDDEN_PROVIDERS from environment and provides functions to
 * anonymize/deanonymize provider names for the dashboard UI.
 *
 * Hidden providers are mapped to "Provider A", "Provider B", etc.
 * based on alphabetical sorting of the hidden providers list.
 */

/**
 * Reads the HIDDEN_PROVIDERS environment variable and returns
 * an array of provider names that should be anonymized.
 *
 * The env var is a comma-separated list (whitespace-trimmed).
 * Returns an empty array if the env var is not set or is empty.
 */
export function getHiddenProviders(): string[] {
  const raw = process.env.HIDDEN_PROVIDERS;
  if (!raw || raw.trim() === "") {
    return [];
  }
  return raw
    .split(",")
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/**
 * Returns the anonymized display name for a given provider.
 *
 * - If the provider is NOT in the hidden list, returns the provider name as-is.
 * - If the provider IS in the hidden list, maps it to "Provider A", "Provider B", etc.
 *   The mapping is based on alphabetical sorting of all hidden providers.
 *
 * @param provider - The real provider name to anonymize
 * @param allProviders - The complete list of all known provider names (used for context)
 * @returns The anonymized display name
 */
export function anonymizeProvider(
  provider: string,
  allProviders: string[]
): string {
  const hiddenProviders = getHiddenProviders();

  // If no hidden providers are configured, return the real name
  if (hiddenProviders.length === 0) {
    return provider;
  }

  const isHidden = hiddenProviders.includes(provider);

  if (!isHidden) {
    return provider;
  }

  // Sort hidden providers alphabetically for deterministic mapping
  const sortedHidden = [...hiddenProviders].sort();

  // Find the index of this provider in the sorted hidden list
  const index = sortedHidden.indexOf(provider);

  if (index === -1) {
    // Shouldn't happen since we already checked includes(), but safeguard
    return provider;
  }

  // Map index to letter: 0 -> A, 1 -> B, 2 -> C, etc.
  const letter = String.fromCharCode(65 + index); // 65 is ASCII 'A'

  return `Provider ${letter}`;
}

/**
 * Reverses the anonymization: given an anonymized name like "Provider A",
 * returns the real provider name. Returns null if no match is found.
 *
 * @param anonymizedName - The anonymized display name (e.g. "Provider A")
 * @param allProviders - The complete list of all known provider names
 * @returns The real provider name, or null if not found
 */
export function deanonymizeProvider(
  anonymizedName: string,
  allProviders: string[]
): string | null {
  const hiddenProviders = getHiddenProviders();

  if (hiddenProviders.length === 0) {
    // No hidden providers, so the anonymized name IS the real name
    // Check if it exists in allProviders
    return allProviders.includes(anonymizedName) ? anonymizedName : null;
  }

  // Parse the letter from "Provider A" format
  const match = anonymizedName.match(/^Provider ([A-Z])$/);
  if (!match) {
    // Not an anonymized name; it might be a real visible provider name
    return allProviders.includes(anonymizedName) ? anonymizedName : null;
  }

  const letter = match[1];
  const index = letter.charCodeAt(0) - 65; // 'A' -> 0, 'B' -> 1, etc.

  const sortedHidden = [...hiddenProviders].sort();

  if (index < 0 || index >= sortedHidden.length) {
    return null;
  }

  return sortedHidden[index];
}
