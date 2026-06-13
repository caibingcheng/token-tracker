import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { normalizeModel } from "@/lib/model-utils";
import { getDisplayName } from "@/lib/model-registry";
import { getCachedModels } from "@/lib/cache";

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
export async function GET(request: NextRequest) {
  await initDatabase();
  try {
    const data = await getCachedModels(async () => {
      // Query all unique raw model names
      const rows = await db
        .selectDistinct({
          model: tokenRecords.model,
        })
        .from(tokenRecords);

      const allRawModels: string[] = rows
        .map((row) => row.model)
        .filter((name): name is string => name !== null && name !== undefined);

      // Normalize and deduplicate
      const normalizedSet = new Set<string>();
      for (const raw of allRawModels) {
        normalizedSet.add(normalizeModel(raw));
      }

      const normalizedList = Array.from(normalizedSet).sort();

      return normalizedList.map((id) => ({
        id,
        name: getDisplayName(id),
      }));
    });

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
}
