import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { getSnapshot } from "@/lib/models-dev/snapshot";
import { matchModelsDevModel } from "@/lib/models-dev/match";

// Price Picker Modal 候选列表：给定 model，返回快照中全部候选（provider、价格、预选标记）

export const dynamic = "force-dynamic";

export const GET = withAuth(async (request: NextRequest) => {
  const model = new URL(request.url).searchParams.get("model") ?? "";
  if (!model) {
    return NextResponse.json({ success: false, error: "model query parameter is required" }, { status: 400 });
  }
  const snapshot = await getSnapshot();
  if (!snapshot) {
    return NextResponse.json({ success: true, data: [] });
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
