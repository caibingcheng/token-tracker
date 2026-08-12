import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { normalizeModel } from "@/lib/model-utils";
import { loadHiddenProviderGroups } from "@/lib/provider-utils";
import { loadModelAliases } from "@/lib/auth/settings";
import { withAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";
import { getDisplayName } from "@/lib/model-registry";

/**
 * GET /api/models
 *
 * Returns a list of all unique normalized model names in the database,
 * deduplicated and sorted alphabetically.
 *
 * Response format:
 * {
 *   success: true,
 *   data: [
 *     { id: "gpt-4o", name: "gpt-4o" },
 *     { id: "k2p6", name: "k2p6" }
 *   ]
 * }
 */
export const GET = withAuth(async (request: NextRequest) => {
  await initDatabase();
  try {
    const groups = await loadHiddenProviderGroups();
    const aliases = await loadModelAliases();

    // Query all unique (model, provider) pairs
    const rows = await db
      .selectDistinct({
        model: tokenRecords.model,
        provider: tokenRecords.provider,
      })
      .from(tokenRecords);

    // Normalize with provider and deduplicate
    const normalizedSet = new Set<string>();
    for (const row of rows) {
      const raw = row.model;
      const provider = row.provider ?? undefined;
      if (raw) {
        normalizedSet.add(normalizeModel(raw, provider, groups, aliases));
      }
    }

    const normalizedList = Array.from(normalizedSet).sort();

    const data = normalizedList.map((id) => ({
      id,
      name: getDisplayName(id, aliases),
    }));

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching models:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch models",
      },
      { status: 500 }
    );
  }
});
