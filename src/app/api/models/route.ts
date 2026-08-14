import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { normalizeModel } from "@/lib/model-utils";
import { loadHiddenProviderGroups } from "@/lib/provider-utils";
import { loadModelAliases, loadHiddenSources } from "@/lib/auth/settings";
import { and, notInArray } from "drizzle-orm";
import { withAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";
import { getDisplayName } from "@/lib/model-registry";

/**
 * GET /api/models
 *
 * Returns a list of all unique normalized model names in the database,
 * deduplicated and sorted alphabetically.
 * Rows belonging to hidden sources (hidden_sources upstreams / virtual keys)
 * are filtered out; pass ?includeHidden=1 to skip the filter.
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
    const { searchParams } = new URL(request.url);
    const includeHidden = searchParams.get("includeHidden") === "1";

    const groups = await loadHiddenProviderGroups();
    const aliases = await loadModelAliases();
    const hiddenSources = includeHidden ? null : await loadHiddenSources();
    const hiddenUpstreams = hiddenSources?.upstreams ?? [];
    const hiddenVirtualKeys = hiddenSources?.virtualKeys ?? [];

    // Query all unique (model, provider) pairs
    let query = db
      .selectDistinct({
        model: tokenRecords.model,
        provider: tokenRecords.provider,
      })
      .from(tokenRecords);

    // 行级过滤：隐藏 upstream 的独有 model 一并消失（与「隐藏项不出现在筛选器」语义一致）
    if (hiddenSources && (hiddenUpstreams.length > 0 || hiddenVirtualKeys.length > 0)) {
      const conditions = [];
      if (hiddenUpstreams.length > 0) {
        conditions.push(notInArray(tokenRecords.provider, hiddenUpstreams));
      }
      if (hiddenVirtualKeys.length > 0) {
        conditions.push(notInArray(tokenRecords.agent, hiddenVirtualKeys));
      }
      query = query.where(and(...conditions));
    }

    const rows = await query;

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
