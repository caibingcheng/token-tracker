import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { withAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";
import { anonymizeProvider, loadHiddenProviderGroups } from "@/lib/provider-utils";

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
export const GET = withAuth(async (request: NextRequest) => {
  await initDatabase();
  try {
    const groups = await loadHiddenProviderGroups();

    // Query all unique provider names from the token_records table
    const rows = await db
      .selectDistinct({
        provider: tokenRecords.provider,
      })
      .from(tokenRecords);

    // Extract provider names into a flat array
    const allProviderNames: string[] = rows
      .map((row: any) => row.provider)
      .filter((name: any): name is string => name !== null && name !== undefined);

    // Anonymize each provider name for the response
    const anonymizedList = allProviderNames.map((realName) => {
      const displayName = anonymizeProvider(realName, allProviderNames, groups);
      return {
        id: displayName,
        name: displayName,
      };
    });

    // Sort alphabetically by display name for consistent ordering
    anonymizedList.sort((a, b) => a.name.localeCompare(b.name));

    // Deduplicate: multiple real providers may map to the same anonymized name
    const seen = new Set<string>();
    const uniqueList = anonymizedList.filter((item) => {
      if (seen.has(item.name)) return false;
      seen.add(item.name);
      return true;
    });

    const data = uniqueList;

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
});
