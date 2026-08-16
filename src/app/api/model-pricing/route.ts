import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase, modelPricesTable } from "@/lib/db";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import { getSnapshot } from "@/lib/models-dev/snapshot";
import {
  searchModelsDevModel,
  buildModelsDevIndex,
  listProviderModels,
  normalizeModelKey,
  stripDateVariant,
  type PriceCandidate,
} from "@/lib/models-dev/match";
import { type ModelPricing } from "@/lib/cost-utils";

export const dynamic = "force-dynamic";

function toPricing(c: PriceCandidate): ModelPricing {
  return {
    canonicalId: c.modelsDevId,
    displayName: `${c.providerName} · ${c.modelId}`,
    inputPrice: c.inputPrice,
    cacheReadPrice: c.cacheReadPrice ?? c.inputPrice,
    cacheWritePrice: c.cacheWritePrice ?? c.inputPrice,
    outputPrice: c.outputPrice,
    provider: c.providerId,
  };
}

// GET /api/model-pricing
// 无参数：返回 model_prices 表全部已定价模型（PriceSimulatorModal 下拉数据源），
//   附带 models.dev 推断的 provider 分组字段 + providers 全量列表（`{id, name}[]`）。
// ?provider=X：返回 models.dev 快照中该 provider 的全部模型（懒加载数据源，可仿真任意模型）。
// ?search=q：全量扫描 models.dev 快照，返回名字包含 q 的条目（搜索模式）。
// canonicalId 语义 = model 名（已定价）/ `providerId/modelId`（models.dev），cache 价缺失回退 input。
export const GET = withAuth(async (request: NextRequest) => {
  try {
    const search = request.nextUrl.searchParams.get("search") ?? "";
    const providerId = request.nextUrl.searchParams.get("provider") ?? "";

    if (search.trim()) {
      const snapshot = await getSnapshot();
      if (!snapshot) {
        return NextResponse.json({ success: true, data: [] });
      }
      const data = searchModelsDevModel(search, snapshot.data).map((c) =>
        toPricing(c)
      );
      return NextResponse.json({ success: true, data });
    }

    if (providerId.trim()) {
      const snapshot = await getSnapshot();
      if (!snapshot) {
        return NextResponse.json({ success: true, data: [] });
      }
      const data = listProviderModels(snapshot.data, providerId.trim()).map(
        (c) => toPricing(c)
      );
      return NextResponse.json({ success: true, data });
    }

    await initDatabase();

    const rows = await withSkipCache(async () => {
      return db.select().from(modelPricesTable);
    });
    const snapshot = await getSnapshot();
    const index = snapshot ? buildModelsDevIndex(snapshot.data) : null;
    // 响应字段保留 canonicalId（语义 = model 名），PriceSimulatorModal 前端零改动
    const data: ModelPricing[] = rows.map((row: any) => ({
      canonicalId: row.model,
      displayName: row.model,
      inputPrice: row.inputPrice,
      cacheReadPrice: row.cacheReadPrice ?? row.inputPrice,
      cacheWritePrice: row.cacheWritePrice ?? row.inputPrice,
      outputPrice: row.outputPrice,
      // 推断 provider 分组：归一化（含日期变体剥离）命中 models.dev 即归入该 provider
      provider:
        index?.get(normalizeModelKey(row.model))?.providerId ??
        index?.get(normalizeModelKey(stripDateVariant(row.model)))?.providerId,
    }));
    const providers = snapshot
      ? Object.entries(snapshot.data)
          .map(([id, p]) => ({
            id,
            name: typeof p?.name === "string" ? p.name : id,
          }))
          .sort((a, b) => a.id.localeCompare(b.id))
      : [];

    return NextResponse.json({
      success: true,
      data,
      providers,
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
