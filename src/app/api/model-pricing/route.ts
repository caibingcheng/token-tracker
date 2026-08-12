import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase, modelPricesTable } from "@/lib/db";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import { type ModelPricing } from "@/lib/cost-utils";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (_request: NextRequest) => {
  try {
    await initDatabase();

    const rows = await withSkipCache(async () => {
      return db.select().from(modelPricesTable);
    });
    // 响应字段保留 canonicalId（语义 = model 名），PriceSimulatorModal 前端零改动
    const data: ModelPricing[] = rows.map((row: any) => ({
      canonicalId: row.model,
      displayName: row.model,
      inputPrice: row.inputPrice,
      cacheReadPrice: row.cacheReadPrice ?? row.inputPrice,
      cacheWritePrice: row.cacheWritePrice ?? row.inputPrice,
      outputPrice: row.outputPrice,
    }));

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching model pricing:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch model pricing",
      },
      { status: 500 }
    );
  }
});
