import { NextRequest, NextResponse } from "next/server";
import { initDatabase } from "@/lib/db";
import { getCachedModelPricing } from "@/lib/cache";
import { getRegistry } from "@/lib/model-registry";
import { type ModelPricing } from "@/lib/cost-utils";

export async function GET(_request: NextRequest) {
  try {
    await initDatabase();

    const data = await getCachedModelPricing<ModelPricing[]>(async () => {
      const { priceMap } = getRegistry();
      return Array.from(priceMap.values());
    });

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
}
