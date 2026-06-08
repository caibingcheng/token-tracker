import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { sql, desc, eq, and, gte, lte, inArray, SQL } from "drizzle-orm";
import { resolveProviderFilter } from "@/lib/provider-utils";
import { normalizeModel, resolveNormalizedModelFilter } from "@/lib/model-utils";

export async function GET(request: NextRequest) {
  await initDatabase();
  try {
    const { searchParams } = new URL(request.url);

    // 分页参数
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50")));
    const offset = (page - 1) * limit;

    // 筛选条件
    const modelParam = searchParams.get("model");

    const provider = searchParams.get("provider");
    // Resolve provider filter if a specific one is selected
    let providerFilter: string[] | null = null;
    if (provider) {
      const allProviderRows = await db
        .selectDistinct({ provider: tokenRecords.provider })
        .from(tokenRecords);
      const allProviderNames: string[] = allProviderRows
        .map((r) => r.provider)
        .filter((n): n is string => n !== null && n !== undefined);

      providerFilter = resolveProviderFilter(provider, allProviderNames);

      if (!providerFilter || providerFilter.length === 0) {
        return NextResponse.json(
          { success: false, error: `Unknown provider: ${provider}` },
          { status: 400 }
        );
      }
    }

    // Resolve model filter if a specific one is selected
    let modelFilter: string[] | null = null;
    if (modelParam) {
      const allModelRows = await db
        .selectDistinct({ model: tokenRecords.model })
        .from(tokenRecords);
      const allRawModels: string[] = allModelRows
        .map((r) => r.model)
        .filter((n): n is string => n !== null && n !== undefined);

      modelFilter = resolveNormalizedModelFilter(modelParam, allRawModels);

      if (!modelFilter || modelFilter.length === 0) {
        return NextResponse.json(
          { success: false, error: `Unknown model: ${modelParam}` },
          { status: 400 }
        );
      }
    }

    const conditions: SQL[] = [];

    if (modelFilter) {
      if (modelFilter.length === 1) {
        conditions.push(eq(tokenRecords.model, modelFilter[0]));
      } else {
        conditions.push(inArray(tokenRecords.model, modelFilter));
      }
    }
    if (providerFilter) {
      if (providerFilter.length === 1) {
        conditions.push(eq(tokenRecords.provider, providerFilter[0]));
      } else {
        conditions.push(inArray(tokenRecords.provider, providerFilter));
      }
    }

    const startDate = searchParams.get("startDate");
    if (startDate) conditions.push(gte(tokenRecords.createdAt, new Date(startDate)));

    const endDate = searchParams.get("endDate");
    if (endDate) {
      const end = new Date(endDate);
      end.setDate(end.getDate() + 1);
      conditions.push(lte(tokenRecords.createdAt, end));
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    // 查询数据
    const query = db
      .select({
        id: tokenRecords.id,
        model: tokenRecords.model,
        inputTokens: tokenRecords.inputTokens,
        outputTokens: tokenRecords.outputTokens,
        cacheRead: tokenRecords.cacheRead,
        cacheWrite: tokenRecords.cacheWrite,
        createdAt: tokenRecords.createdAt,
      })
      .from(tokenRecords)
      .orderBy(desc(tokenRecords.createdAt))
      .limit(limit)
      .offset(offset);
    const rawData = whereClause ? await query.where(whereClause) : await query;
    const data = rawData.map((record) => ({
      ...record,
      normalizedModel: normalizeModel(record.model),
    }));

    // 查询总数
    const countQuery = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(tokenRecords);
    const countResult = whereClause
      ? await countQuery.where(whereClause)
      : await countQuery;

    const total = countResult[0].count;

    return NextResponse.json({
      success: true,
      data,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    console.error("Records error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
