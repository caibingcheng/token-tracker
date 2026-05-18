import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { sql } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const apiKey = request.headers.get("X-API-Key")!;
    const { searchParams } = new URL(request.url);
    const groupBy = searchParams.get("groupBy") || "date";
    const range = searchParams.get("range") || "30d";

    // 计算时间范围
    let dateFilter: Date | null = null;
    if (range !== "all") {
      const days = parseInt(range);
      dateFilter = new Date();
      dateFilter.setDate(dateFilter.getDate() - days);
    }

    let query;

    if (groupBy === "date") {
      const granularity = searchParams.get("granularity") || "day";
      let dateFormat: string;

      if (granularity === "week") {
        dateFormat = "YYYY-WW";
      } else if (granularity === "month") {
        dateFormat = "YYYY-MM";
      } else {
        dateFormat = "YYYY-MM-DD";
      }

      query = db
        .select({
          group: sql<string>`TO_CHAR(${tokenRecords.createdAt}, ${dateFormat})`,
          totalInput: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheRead: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .where(sql`${tokenRecords.apiKey} = ${apiKey}`)
        .groupBy(sql`TO_CHAR(${tokenRecords.createdAt}, ${dateFormat})`)
        .orderBy(sql`TO_CHAR(${tokenRecords.createdAt}, ${dateFormat})`);

      if (dateFilter) {
        query = query.where(
          sql`${tokenRecords.apiKey} = ${apiKey} AND ${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
        );
      }
    } else if (groupBy === "model") {
      query = db
        .select({
          group: tokenRecords.model,
          totalInput: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheRead: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .where(sql`${tokenRecords.apiKey} = ${apiKey}`)
        .groupBy(tokenRecords.model)
        .orderBy(sql`SUM(${tokenRecords.inputTokens}) DESC`);
    } else {
      // provider
      query = db
        .select({
          group: tokenRecords.provider,
          totalInput: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheRead: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .where(sql`${tokenRecords.apiKey} = ${apiKey}`)
        .groupBy(tokenRecords.provider)
        .orderBy(sql`SUM(${tokenRecords.inputTokens}) DESC`);
    }

    const data = await query;

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Stats error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
