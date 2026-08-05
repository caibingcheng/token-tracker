import { NextRequest, NextResponse } from "next/server";
import { initDatabase } from "@/lib/db";
import { withAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";
import { getRegistry } from "@/lib/model-registry";
import { type ModelPricing } from "@/lib/cost-utils";

export const GET = withAuth(async (_request: NextRequest) => {
  try {
    await initDatabase();

    const { priceMap } = getRegistry();
    const data: ModelPricing[] = Array.from(priceMap.values());

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
