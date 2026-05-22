import { NextRequest, NextResponse } from "next/server";
import { initDatabase } from "@/lib/db";
import { executeStatsQuery } from "@/lib/stats-query";
import { getCachedStats } from "@/lib/cache";

export async function GET(request: NextRequest) {
  await initDatabase();
  try {
    const { searchParams } = new URL(request.url);
    const groupBy = searchParams.get("groupBy") || "date";
    const range = searchParams.get("range") || "30d";
    const providerParam = searchParams.get("provider") || "all";
    const granularity = searchParams.get("granularity") || undefined;

    const data = await getCachedStats(
      { groupBy, range, provider: providerParam, granularity },
      () => executeStatsQuery({ groupBy, range, provider: providerParam, granularity })
    );

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Stats error:", error);
    
    // Handle unknown provider error specifically
    if (error instanceof Error && error.message.startsWith("Unknown provider:")) {
      return NextResponse.json(
        { success: false, error: error.message },
        { status: 400 }
      );
    }
    
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
