import { NextRequest, NextResponse } from "next/server";
import { initDatabase, db } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { executeStatsQuery } from "@/lib/stats-query";
import { unstable_cache } from "next/cache";
import { deanonymizeProvider } from "@/lib/provider-utils";

const DASHBOARD_CACHE_TAG = "api-dashboard";

const dashboardCacheFn = unstable_cache(
  async (range: string, provider: string, providerFilter: string | null) => {
    const [total, daily, models] = await Promise.all([
      executeStatsQuery({ groupBy: "none", range: "all", provider, providerFilter }),
      executeStatsQuery({ groupBy: "date", range, provider, granularity: "day", providerFilter }),
      executeStatsQuery({ groupBy: "model", range, provider, providerFilter }),
    ]);
    return { total, daily, models };
  },
  ["dashboard"],
  { tags: [DASHBOARD_CACHE_TAG], revalidate: false }
);

const VALID_RANGES = ["3d", "7d", "14d", "30d"];

export async function GET(request: NextRequest) {
  await initDatabase();
  try {
    const { searchParams } = new URL(request.url);
    const range = searchParams.get("range") || "7d";
    const provider = searchParams.get("provider") || "all";

    // 参数校验
    if (!VALID_RANGES.includes(range)) {
      return NextResponse.json(
        { success: false, error: `Invalid range. Must be one of: ${VALID_RANGES.join(", ")}` },
        { status: 400 }
      );
    }

    // 预先查询 provider mapping（避免 N+1 查询）
    let providerFilter: string | null = null;
    if (provider !== "all") {
      const allProviderRows = await db
        .selectDistinct({ provider: tokenRecords.provider })
        .from(tokenRecords);
      const allProviderNames = allProviderRows
        .map((r) => r.provider)
        .filter((n): n is string => n !== null && n !== undefined);

      providerFilter = deanonymizeProvider(provider, allProviderNames);

      if (!providerFilter) {
        return NextResponse.json(
          { success: false, error: `Unknown provider: ${provider}` },
          { status: 400 }
        );
      }
    }

    const data = await dashboardCacheFn(range, provider, providerFilter);
    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Dashboard error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}