import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { anonymizeProvider } from "@/lib/provider-utils";
import { getCachedProviders } from "@/lib/cache";

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
    const data = await getCachedProviders(async () => {
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

      return anonymizedList;
    });

    return NextResponse.json({
      success: true,
      data,
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
