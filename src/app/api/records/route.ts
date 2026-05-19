import { NextRequest, NextResponse } from "next/server";
import { db } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { sql, desc, eq, and, gte, lte } from "drizzle-orm";

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);

    // 分页参数
    const page = Math.max(1, parseInt(searchParams.get("page") || "1"));
    const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50")));
    const offset = (page - 1) * limit;

    // 筛选条件
    const conditions: any[] = [];

    const model = searchParams.get("model");
    if (model) conditions.push(eq(tokenRecords.model, model));

    const provider = searchParams.get("provider");
    if (provider) conditions.push(eq(tokenRecords.provider, provider));

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
      .select()
      .from(tokenRecords)
      .orderBy(desc(tokenRecords.createdAt))
      .limit(limit)
      .offset(offset);
    const data = whereClause ? await query.where(whereClause) : await query;

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
