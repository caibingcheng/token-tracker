import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";
import { revalidateTag } from "next/cache";
import { eq } from "drizzle-orm";
import { MODELS_CACHE_TAG, STATS_CACHE_TAG } from "@/lib/cache";

const DASHBOARD_CACHE_TAG = "api-dashboard";
const PROVIDERS_CACHE_TAG = "api-providers";

export async function POST(request: NextRequest) {
  await initDatabase();
  try {
    const body = await request.json();

    // 验证必填字段
    if (!body.model || !body.provider) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: model, provider" },
        { status: 400 }
      );
    }

    const inputTokens = Math.max(0, Number(body.inputTokens) || 0);
    const outputTokens = Math.max(0, Number(body.outputTokens) || 0);
    const cacheRead = Math.max(0, Number(body.cacheRead) || 0);
    const cacheWrite = Math.max(0, Number(body.cacheWrite) || 0);

    // 如果所有 token 数都为 0，则丢弃无效数据
    if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) {
      return NextResponse.json(
        { success: true, skipped: true, message: "All token values are zero, record discarded" },
        { status: 200 }
      );
    }

    const provider = String(body.provider);
    const model = String(body.model);

    // 检查是否为新 provider（使 providers 缓存失效）
    const existingProviders = await db
      .selectDistinct({ provider: tokenRecords.provider })
      .from(tokenRecords)
      .where(eq(tokenRecords.provider, provider));
    const isNewProvider = existingProviders.length === 0;

    // 检查是否为新 model（使 models 缓存失效）
    const existingModels = await db
      .selectDistinct({ model: tokenRecords.model })
      .from(tokenRecords)
      .where(eq(tokenRecords.model, model));
    const isNewModel = existingModels.length === 0;

    // 插入记录
    const result = await db
      .insert(tokenRecords)
      .values({
        model,
        provider,
        inputTokens,
        outputTokens,
        cacheRead,
        cacheWrite,
      })
      .returning();

    // 使 Dashboard 与 Stats 缓存失效
    revalidateTag(DASHBOARD_CACHE_TAG);
    revalidateTag(STATS_CACHE_TAG);

    // 如果是新 provider，使 Providers 缓存失效
    if (isNewProvider) {
      revalidateTag(PROVIDERS_CACHE_TAG);
    }

    // 如果是新 model，使 Models 缓存失效
    if (isNewModel) {
      revalidateTag(MODELS_CACHE_TAG);
    }

    return NextResponse.json({ success: true, id: result[0].id });
  } catch (error) {
    console.error("Ingest error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}