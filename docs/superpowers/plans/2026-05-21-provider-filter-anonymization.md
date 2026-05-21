# Provider Filter & Anonymization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add provider filtering to the dashboard with anonymization support for hidden providers (company gateways), allowing users to compare cache hit rates across different providers without exposing sensitive provider identities.

**Architecture:** Use an environment variable `HIDDEN_PROVIDERS` to define which providers should be anonymized. Create a utility module for provider anonymization logic (mapping hidden providers to "Provider A", "Provider B", etc.). Add a new `/api/providers` endpoint that returns the anonymized list. Modify `/api/stats` to accept a `provider` query parameter for filtering. Update the Dashboard UI with a provider dropdown selector.

**Tech Stack:** Next.js 14, React, TypeScript, Drizzle ORM, PostgreSQL, Tailwind CSS, Recharts

---

## File Structure

- **Create:** `src/lib/provider-utils.ts` — Provider anonymization/deanonymization utilities
- **Create:** `src/app/api/providers/route.ts` — GET endpoint returning anonymized provider list
- **Modify:** `.env.example` — Add `HIDDEN_PROVIDERS` configuration
- **Modify:** `src/app/api/stats/route.ts` — Add provider filtering to all query paths
- **Modify:** `src/components/Dashboard.tsx` — Add provider dropdown and integrate filtering

---

## Task 1: Create Provider Anonymization Utilities

**Files to create:**
- `src/lib/provider-utils.ts`

**Step-by-step implementation:**

1. Create `src/lib/provider-utils.ts` with three exported functions:

```typescript
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
  if (!raw || raw.trim() === '') {
    return [];
  }
  return raw
    .split(',')
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
```

2. Verify the file is syntactically correct by running the TypeScript compiler:

```bash
npx tsc --noEmit src/lib/provider-utils.ts
```

**Expected behavior:**
- `getHiddenProviders()` reads the env var and returns a clean array
- `anonymizeProvider()` replaces hidden provider names with "Provider A"/"Provider B" labels
- `deanonymizeProvider()` reverses the mapping back to the real name
- All functions work correctly when HIDDEN_PROVIDERS is empty/not set

**Verification:**
- Unit test expectations (manual):
  - `getHiddenProviders()` with `HIDDEN_PROVIDERS="openai,anthropic"` returns `["openai", "anthropic"]`
  - `anonymizeProvider("openai", ["openai", "anthropic", "google"])` returns `"Provider A"`
  - `anonymizeProvider("anthropic", ["openai", "anthropic", "google"])` returns `"Provider B"`
  - `anonymizeProvider("google", ["openai", "anthropic", "google"])` returns `"google"`
  - `deanonymizeProvider("Provider A", ["openai", "anthropic", "google"])` returns `"openai"`
  - `deanonymizeProvider("google", ["openai", "anthropic", "google"])` returns `"google"`
  - `deanonymizeProvider("Provider Z", ["openai", "anthropic", "google"])` returns `null`

**Git commit:**
```bash
git add src/lib/provider-utils.ts
git commit -m "feat(providers): create provider anonymization utilities

- Add getHiddenProviders() to read HIDDEN_PROVIDERS env var
- Add anonymizeProvider() to map hidden providers to 'Provider A/B/C'
- Add deanonymizeProvider() to reverse the mapping
- All functions handle empty/unset env var gracefully"
```

---

## Task 2: Update Environment Configuration

**Files to modify:**
- `.env.example`

**Step-by-step implementation:**

1. Add the new configuration entry with a descriptive comment:

```diff
  # API Keys (comma separated)
  API_KEYS="your-api-key-here"
+
+ # Provider Anonymization (comma-separated list of provider names to hide)
+ HIDDEN_PROVIDERS=""
```

**Expected behavior:**
- Developers see the new configuration option documented
- The empty default `""` means no providers are hidden by default

**Verification:**
- The `.env.example` file contains the new line with proper formatting
- No syntax errors in the file

**Git commit:**
```bash
git add .env.example
git commit -m "chore(config): add HIDDEN_PROVIDERS to environment configuration"
```

---

## Task 3: Create Providers API Endpoint

**Files to create:**
- `src/app/api/providers/route.ts`

**Step-by-step implementation:**

1. Create `src/app/api/providers/route.ts`:

```typescript
import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { anonymizeProvider } from "@/lib/provider-utils";

/**
 * GET /api/providers
 *
 * Returns a list of all unique providers in the database,
 * with hidden providers anonymized to "Provider A", "Provider B", etc.
 *
 * Response format:
 * {
 *   success: true,
 *   data: [
 *     { id: "Provider A", name: "Provider A" },
 *     { id: "google", name: "google" }
 *   ]
 * }
 */
export async function GET(request: NextRequest) {
  await initDatabase();
  try {
    // Query all unique provider names from the token_records table
    const rows = await db
      .selectDistinct({
        provider: tokenRecords.provider,
      })
      .from(tokenRecords);

    // Extract provider names into a flat array
    const allProviderNames: string[] = rows
      .map((row) => row.provider)
      .filter((name): name is string => name !== null && name !== undefined);

    // Anonymize each provider name for the response
    const anonymizedList = allProviderNames.map((realName) => {
      const displayName = anonymizeProvider(realName, allProviderNames);
      return {
        id: displayName,   // Use anonymized name as ID for dropdown value
        name: displayName, // Use anonymized name as display label
      };
    });

    // Sort alphabetically by display name for consistent ordering
    anonymizedList.sort((a, b) => a.name.localeCompare(b.name));

    return NextResponse.json({
      success: true,
      data: anonymizedList,
    });
  } catch (error) {
    console.error("Error fetching providers:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch providers",
      },
      { status: 500 }
    );
  }
}
```

**Expected behavior:**
- A GET request to `/api/providers` returns a JSON array of providers
- Hidden providers appear as "Provider A", "Provider B" etc.
- Non-hidden providers appear as their real names
- The list is sorted alphabetically
- Empty database returns `{ success: true, data: [] }`

**Verification:**
- Start the dev server and hit the endpoint:
```bash
curl http://localhost:3000/api/providers
```
- With `HIDDEN_PROVIDERS=""`, all provider real names are returned
- With `HIDDEN_PROVIDERS="openai"`, if "openai" exists in DB it shows as "Provider A"
- With `HIDDEN_PROVIDERS="openai,anthropic"`, they map to "Provider A" and "Provider B"

**Git commit:**
```bash
git add src/app/api/providers/route.ts
git commit -m "feat(api): add /api/providers endpoint with anonymization support

- Query all unique providers from token_records table
- Anonymize hidden providers using provider-utils
- Return sorted list with id and name fields"
```

---

## Task 4: Modify Stats API for Provider Filtering

**Files to modify:**
- `src/app/api/stats/route.ts`

**Step-by-step implementation:**

1. Add import for `deanonymizeProvider` at the top of the file:

```typescript
import { deanonymizeProvider } from "@/lib/provider-utils";
```

2. At the top of the handler function, after parsing `groupBy` and `range`, add provider parameter parsing:

```typescript
const providerParam = searchParams.get("provider") || "all";
```

3. After the `dateFilter` calculation, add provider deanonymization:

```typescript
// Deanonymize provider if a specific one is selected
let providerFilter: string | null = null;
if (providerParam !== "all") {
  // We need the full provider list to deanonymize; fetch it
  const allProviderRows = await db
    .selectDistinct({ provider: tokenRecords.provider })
    .from(tokenRecords);
  const allProviderNames: string[] = allProviderRows
    .map((r) => r.provider)
    .filter((n): n is string => n !== null && n !== undefined);

  providerFilter = deanonymizeProvider(providerParam, allProviderNames);

  if (!providerFilter) {
    return NextResponse.json(
      { success: false, error: `Unknown provider: ${providerParam}` },
      { status: 400 }
    );
  }
}
```

4. Add a helper function to build WHERE clause with date and provider filters:

```typescript
// Helper to build combined WHERE clause
function buildWhereClause(
  dateFilter: Date | null,
  providerFilter: string | null
) {
  if (dateFilter && providerFilter) {
    return sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()} AND ${tokenRecords.provider} = ${providerFilter}`;
  } else if (dateFilter) {
    return sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`;
  } else if (providerFilter) {
    return sql`${tokenRecords.provider} = ${providerFilter}`;
  }
  return null;
}
```

5. Modify each groupBy path to use the combined WHERE clause:

**For `groupBy === "none"`:**

Replace:
```typescript
if (dateFilter) {
  query = query.where(
    sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
  );
}
```

With:
```typescript
const whereClause = buildWhereClause(dateFilter, providerFilter);
if (whereClause) {
  query = query.where(whereClause);
}
```

**For `groupBy === "date"`:**

Replace:
```typescript
if (dateFilter) {
  query = query.where(
    sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
  );
}
```

With:
```typescript
const whereClause = buildWhereClause(dateFilter, providerFilter);
if (whereClause) {
  query = query.where(whereClause);
}
```

**For `groupBy === "date-model"`:**

Replace:
```typescript
if (dateFilter) {
  query = query.where(
    sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
  );
}
```

With:
```typescript
const whereClause = buildWhereClause(dateFilter, providerFilter);
if (whereClause) {
  query = query.where(whereClause);
}
```

**For `groupBy === "model"`:**

Replace:
```typescript
const rawData = dateFilter
  ? await rawQuery.where(
      sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
    )
  : await rawQuery;
```

With:
```typescript
const whereClause = buildWhereClause(dateFilter, providerFilter);
const rawData = whereClause
  ? await rawQuery.where(whereClause)
  : await rawQuery;
```

**For `groupBy === "provider"` (else branch):**

Replace:
```typescript
query = db
  .select({
    group: tokenRecords.provider,
    totalInput: sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
    totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
    totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
    totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
    totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
    count: sql<number>`COUNT(*)`,
  })
  .from(tokenRecords)
  .groupBy(tokenRecords.provider)
  .orderBy(sql`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead}) DESC`);
```

With:
```typescript
query = db
  .select({
    group: tokenRecords.provider,
    totalInput: sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
    totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
    totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
    totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
    totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
    count: sql<number>`COUNT(*)`,
  })
  .from(tokenRecords)
  .groupBy(tokenRecords.provider)
  .orderBy(sql`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead}) DESC`);

const whereClause = buildWhereClause(dateFilter, providerFilter);
if (whereClause) {
  query = query.where(whereClause);
}
```

**Important considerations:**
- The provider filter uses parameterized queries via Drizzle's `sql` tagged template literals
- When `providerParam === "all"`, no provider filter is applied — matches current behavior
- Hidden provider names in the URL are the anonymized names (e.g., `provider=Provider%20A`)
- The `provider` groupBy path also supports filtering by a specific provider (useful for consistency)

**Expected behavior after modifications:**
- `GET /api/stats?groupBy=none&range=all` — returns data for all providers (unchanged behavior)
- `GET /api/stats?groupBy=none&range=all&provider=Provider%20A` — returns data filtered to that specific hidden provider
- `GET /api/stats?groupBy=model&provider=google` — returns Top 5 models filtered to the visible provider "google"
- `GET /api/stats?groupBy=date&range=30d&provider=Provider%20A` — returns daily data filtered to the hidden provider
- `GET /api/stats?provider=Unknown` — returns 400 error with "Unknown provider" message
- `GET /api/stats?groupBy=date&range=30d&provider=Provider%20A` — combines date and provider filters

**Verification:**
- Test each groupBy path with and without provider filter
- Test with anonymized provider names (e.g., "Provider A")
- Test with real provider names (e.g., "google")
- Test with "all" to ensure backward compatibility
- Verify no SQL errors in the console
- Check that cache hit rates differ between providers

**Git commit:**
```bash
git add src/app/api/stats/route.ts
git commit -m "feat(api): add provider filtering to /api/stats endpoint

- Parse 'provider' query parameter and deanonymize it
- Build dynamic WHERE conditions for date and provider filters
- Apply provider filter to all groupBy paths (none, date, date-model, model, provider)
- Use parameterized queries via Drizzle ORM sql templates for SQL injection safety
- Return 400 error for unknown provider names"
```

---

## Task 5: Update Dashboard with Provider Selector

**Files to modify:**
- `src/components/Dashboard.tsx`

**Step-by-step implementation:**

1. Add new state variables inside the component function (after existing data states):

```typescript
// Data states
const [stats, setStats] = useState<Stats | null>(null);
const [topModels, setTopModels] = useState<ModelStat[]>([]);
const [dailyData, setDailyData] = useState<DailyData[]>([]);

// NEW: Provider filter states
const [providers, setProviders] = useState<Array<{ id: string; name: string }>>([]);
const [selectedProvider, setSelectedProvider] = useState<string>("all");
const selectedProviderRef = useRef<string>("all");
```

2. Add provider list fetch on mount:

```typescript
// Fetch provider list on mount
useEffect(() => {
  async function fetchProviders() {
    try {
      const res = await fetch("/api/providers");
      const json = await res.json();
      if (json.success && Array.isArray(json.data)) {
        setProviders(json.data);
      }
    } catch (err) {
      console.error("Failed to fetch providers:", err);
    }
  }
  fetchProviders();
}, []); // Empty deps — fetch once on mount
```

3. Modify the `fetchAll` function to append provider parameter to all API calls:

Replace:
```typescript
const [statsRes, top5Res, dailyRes] = await Promise.all([
  fetch("/api/stats?groupBy=none&range=all"),
  fetch("/api/stats?groupBy=model"),
  fetch("/api/stats?groupBy=date&range=30d"),
]);
```

With:
```typescript
const currentProvider = selectedProviderRef.current;

// Build URLs with provider filter
const statsUrl = new URL("/api/stats?groupBy=none&range=all", window.location.origin);
const top5Url = new URL("/api/stats?groupBy=model", window.location.origin);
const dailyUrl = new URL("/api/stats?groupBy=date&range=30d", window.location.origin);

if (currentProvider !== "all") {
  statsUrl.searchParams.set("provider", currentProvider);
  top5Url.searchParams.set("provider", currentProvider);
  dailyUrl.searchParams.set("provider", currentProvider);
}

const [statsRes, top5Res, dailyRes] = await Promise.all([
  fetch(statsUrl.toString()),
  fetch(top5Url.toString()),
  fetch(dailyUrl.toString()),
]);
```

4. Add provider change handler and keep ref in sync:

```typescript
// Keep ref in sync with state
useEffect(() => {
  selectedProviderRef.current = selectedProvider;
}, [selectedProvider]);

// Handle provider selection change
const handleProviderChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
  const value = e.target.value;
  setSelectedProvider(value);
  // Note: fetchAll reads from selectedProviderRef.current, so we need
  // to ensure the ref is updated before calling fetchAll
  selectedProviderRef.current = value;
  fetchAll();
}, [fetchAll]);
```

5. Add the provider dropdown UI in the header area, next to the Auto Refresh checkbox:

Replace:
```tsx
<div className="flex justify-between items-center mb-8">
  <h1 className="text-3xl font-bold">Token Tracker Dashboard</h1>
  <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
    <input
      type="checkbox"
      checked={autoRefresh}
      onChange={(e) => setAutoRefresh(e.target.checked)}
      className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
    />
    Auto Refresh
  </label>
</div>
```

With:
```tsx
<div className="flex justify-between items-center mb-8">
  <h1 className="text-3xl font-bold">Token Tracker Dashboard</h1>
  <div className="flex items-center gap-4">
    {/* Provider Filter */}
    <div className="flex items-center gap-2">
      <label htmlFor="provider-select" className="text-sm text-gray-600">
        Provider:
      </label>
      <select
        id="provider-select"
        value={selectedProvider}
        onChange={handleProviderChange}
        className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      >
        <option value="all">All Providers</option>
        {providers.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </select>
    </div>

    {/* Auto Refresh */}
    <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer">
      <input
        type="checkbox"
        checked={autoRefresh}
        onChange={(e) => setAutoRefresh(e.target.checked)}
        className="w-4 h-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
      />
      Auto Refresh
    </label>
  </div>
</div>
```

**Important:** The `fetchAll` function currently has no dependencies (`useCallback(..., [])`) and reads from refs, which is perfect for avoiding stale closures. Make sure to update `selectedProviderRef` before calling `fetchAll()` in the change handler.

**Expected behavior:**
- On dashboard load, a dropdown shows "All Providers" plus each anonymized provider name
- Selecting a provider re-fetches all data (stats, top-5, daily) with that provider filter
- Switching back to "All Providers" shows unfiltered data
- Hidden providers show as "Provider A", "Provider B" — never real names
- The dropdown remains populated and functional across auto-refresh cycles

**Verification:**
- Dropdown appears in the header next to Auto Refresh checkbox
- Selecting a provider triggers data reload (observe Network tab)
- Provider names in dropdown match the `/api/providers` response
- No stale data appears after switching providers quickly
- Auto-refresh continues to use the selected provider

**Git commit:**
```bash
git add src/components/Dashboard.tsx
git commit -m "feat(ui): add provider filter dropdown to dashboard

- Fetch provider list from /api/providers on mount
- Add selectedProvider state and ref for stale-closure safety
- Add provider dropdown in header next to Auto Refresh
- Append provider query param to all API calls (stats, top5, daily)
- Use useRef to avoid stale closures in fetch callbacks"
```

---

## Task 6: Manual Testing & Verification

**Setup:**

1. Add test data with multiple providers to the database. Insert some test records:

```sql
-- Example test data
INSERT INTO token_records (api_key, model, provider, input_tokens, output_tokens, cache_read, cache_write, created_at)
VALUES
  ('test-key', 'gpt-4o', 'openai', 1000, 500, 800, 0, NOW()),
  ('test-key', 'gpt-4o', 'openai', 2000, 1000, 0, 0, NOW()),
  ('test-key', 'claude-3-5-sonnet', 'anthropic', 1500, 800, 1200, 0, NOW()),
  ('test-key', 'claude-3-5-sonnet', 'anthropic', 800, 400, 0, 0, NOW()),
  ('test-key', 'gemini-1.5-pro', 'google', 500, 250, 400, 0, NOW()),
  ('test-key', 'gemini-1.5-pro', 'google', 600, 300, 500, 0, NOW()),
  ('test-key', 'gpt-4o', 'openai', 3000, 1500, 0, 0, NOW()),
  ('test-key', 'claude-3-5-sonnet', 'anthropic', 2000, 1000, 1800, 0, NOW()),
  ('test-key', 'gemini-1.5-pro', 'google', 1200, 600, 0, 0, NOW());
```

2. Set the `HIDDEN_PROVIDERS` environment variable before starting the dev server:

```bash
# In .env.local or shell:
export HIDDEN_PROVIDERS="openai"
# Then start the server:
npm run dev
```

**Test Scenarios:**

1. **Dropdown shows anonymized names**
   - Open the dashboard
   - Verify the dropdown lists: "All Providers", "Provider A", "anthropic", "google"
   - Verify "openai" does NOT appear (it's hidden)
   - ✓ PASS / FAIL

2. **Select "All Providers"**
   - Select "All Providers" from dropdown
   - Verify the stats match total across all providers
   - Verify cache hit rate is calculated correctly
   - ✓ PASS / FAIL

3. **Select a visible provider**
   - Select "anthropic" from dropdown
   - Verify only anthropic records are shown
   - Cache hit rate should be ~60% (from test data: 1 hit with 1200 cache_read, 1 miss with 0 cache_read out of 2800 total input)
   - ✓ PASS / FAIL

4. **Select "Provider A" (hidden provider)**
   - Select "Provider A" from dropdown
   - Verify data is filtered to openai records only
   - Cache hit rate should be ~26.7% (from test data: 800 cache_read out of 3000 total input on one record)
   - Verify the UI shows "Provider A" NOT "openai" anywhere
   - ✓ PASS / FAIL

5. **Toggle between providers**
   - Switch between different providers
   - Verify data refreshes each time
   - Verify no flash of stale data
   - ✓ PASS / FAIL

6. **API response leak check**
   - Open browser DevTools → Network tab
   - Fetch all providers
   - Inspect responses for each API call
   - Verify no response contains "openai" (the hidden provider)
   - ✓ PASS / FAIL

7. **Auto-refresh with provider filter**
   - Enable Auto Refresh
   - Select a specific provider
   - Wait for auto-refresh cycle
   - Verify data still correctly filtered after refresh
   - ✓ PASS / FAIL

8. **Cache hit rate comparison**
   - Note cache hit rate for each provider
   - Verify the rates make sense and differ between providers
   - ✓ PASS / FAIL

**Cleanup after testing:**

```sql
-- Remove test data
DELETE FROM token_records WHERE api_key = 'test-key';
```

**Git commit:**
```bash
# This is a manual test plan — no code changes to commit
# Create a test results log if desired:
# cat > docs/test-results/provider-filter-test.md << 'EOF'
# ...
# EOF
```

---

## Rollback Plan

If any issues are discovered during testing:

1. **Revert Dashboard changes:**
   ```bash
   git checkout HEAD -- src/components/Dashboard.tsx
   ```

2. **Revert Stats API changes:**
   ```bash
   git checkout HEAD -- src/app/api/stats/route.ts
   ```

3. **Remove new files:**
   ```bash
   git rm src/app/api/providers/route.ts
   git rm src/lib/provider-utils.ts
   ```

4. **Revert env example:**
   ```bash
   git checkout HEAD -- .env.example
   ```

5. **Verify clean state:**
   ```bash
   npm run dev  # Should work as before
   ```
