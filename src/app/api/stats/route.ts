import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { sql } from "drizzle-orm";
import {
  TOP_N_RAW_MODELS,
  TOP_N_DISPLAY,
  aggregateByNormalizedModel,
  type StatItem,
} from "@/lib/model-utils";

export async function GET(request: NextRequest) {
  await initDatabase();
  try {
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

    if (groupBy === "none") {
      query = db
        .select({
          group: sql<string>`'total'`,
          totalInput: sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
          totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords);

      if (dateFilter) {
        query = query.where(
          sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
        );
      }
    } else if (groupBy === "date") {
      const granularity = searchParams.get("granularity") || "day";
      let dateFormat: string;

      if (granularity === "week") {
        dateFormat = "YYYY-WW";
      } else if (granularity === "month") {
        dateFormat = "YYYY-MM";
      } else {
        dateFormat = "YYYY-MM-DD";
      }

      // 使用 sql.raw 内联格式字符串，避免 GROUP BY 参数化问题
      const groupExpr = sql<string>`TO_CHAR(${tokenRecords.createdAt}, ${sql.raw(`'${dateFormat}'`)})`;

      query = db
        .select({
          group: groupExpr,
          totalInput: sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
          totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .groupBy(groupExpr)
        .orderBy(groupExpr);

      if (dateFilter) {
        query = query.where(
          sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
        );
      }
    } else if (groupBy === "date-model") {
      const granularity = searchParams.get("granularity") || "day";
      let dateFormat: string;
      if (granularity === "week") {
        dateFormat = "YYYY-WW";
      } else if (granularity === "month") {
        dateFormat = "YYYY-MM";
      } else {
        dateFormat = "YYYY-MM-DD";
      }
      const groupExpr = sql<string>`TO_CHAR(${tokenRecords.createdAt}, ${sql.raw(`'${dateFormat}'`)})`;

      query = db
        .select({
          group: groupExpr,
          model: tokenRecords.model,
          totalInput: sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
          totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .groupBy(groupExpr, tokenRecords.model)
        .orderBy(groupExpr, tokenRecords.model);

      if (dateFilter) {
        query = query.where(
          sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
        );
      }
    } else if (groupBy === "model") {
      // 先按原始 model 分组取 Top 20，再应用层归一化合并取 Top 5
      const rawQuery = db
        .select({
          group: tokenRecords.model,
          totalInput:
            sql<number>`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead})`,
          totalInputCached: sql<number>`SUM(${tokenRecords.cacheRead})`,
          totalInputUncached: sql<number>`SUM(${tokenRecords.inputTokens})`,
          totalOutput: sql<number>`SUM(${tokenRecords.outputTokens})`,
          totalCacheWrite: sql<number>`SUM(${tokenRecords.cacheWrite})`,
          count: sql<number>`COUNT(*)`,
        })
        .from(tokenRecords)
        .groupBy(tokenRecords.model)
        .orderBy(
          sql`SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead}) DESC`
        )
        .limit(TOP_N_RAW_MODELS);

      const rawData = dateFilter
        ? await rawQuery.where(
            sql`${tokenRecords.createdAt} >= ${dateFilter.toISOString()}`
          )
        : await rawQuery;

      const data = aggregateByNormalizedModel(
        rawData as unknown as StatItem[]
      ).slice(0, TOP_N_DISPLAY);

      return NextResponse.json({ success: true, data });
    } else {
      // provider
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
