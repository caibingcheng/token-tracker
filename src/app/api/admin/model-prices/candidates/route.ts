import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { getSnapshot } from "@/lib/models-dev/snapshot";
import { matchModelsDevModel, searchModelsDevModel } from "@/lib/models-dev/match";
import { loadModelsDevSource } from "@/lib/auth/settings-models-dev-source";

// Price Picker Modal 候选列表：给定 model，返回快照中全部候选（provider、价格、预选标记）。
// 可选 q 参数：搜索模式 —— 全量扫描快照中名字包含 q 的条目（不限匹配管线）。

export const dynamic = "force-dynamic";

export const GET = withAuth(async (request: NextRequest) => {
  const url = new URL(request.url);
  const query = url.searchParams.get("q") ?? "";
  const model = url.searchParams.get("model") ?? "";

  const source = await loadModelsDevSource();
  const snapshot = await getSnapshot({ source });
  if (!snapshot) {
    return NextResponse.json({ success: true, data: [] });
  }

  if (query.trim()) {
    const results = searchModelsDevModel(query, snapshot.data);
    const data = results.map((c) => ({
      providerId: c.providerId,
      providerName: c.providerName,
      modelId: c.modelId,
      modelsDevId: c.modelsDevId,
      inputPrice: c.inputPrice,
      outputPrice: c.outputPrice,
      cacheReadPrice: c.cacheReadPrice,
      cacheWritePrice: c.cacheWritePrice,
      lastUpdated: c.lastUpdated ?? null,
      preferred: false,
    }));
    return NextResponse.json({ success: true, data });
  }

  if (!model) {
    return NextResponse.json({ success: false, error: "model query parameter is required" }, { status: 400 });
  }
  const { matched, candidates } = matchModelsDevModel(model, snapshot.data);
  const data = candidates.map((c) => ({
    providerId: c.providerId,
    providerName: c.providerName,
    modelId: c.modelId,
    modelsDevId: c.modelsDevId,
    inputPrice: c.inputPrice,
    outputPrice: c.outputPrice,
    cacheReadPrice: c.cacheReadPrice,
    cacheWritePrice: c.cacheWritePrice,
    lastUpdated: c.lastUpdated ?? null,
    preferred: matched?.modelsDevId === c.modelsDevId,
  }));
  return NextResponse.json({ success: true, data });
});
