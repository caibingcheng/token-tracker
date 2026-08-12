import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { selectModelsDevPrice } from "@/lib/model-prices-service";
import { getSnapshot } from "@/lib/models-dev/snapshot";
import { matchModelsDevModel } from "@/lib/models-dev/match";

// 从候选选定价格落库（source='models.dev'，记录 models_dev_id）

export const dynamic = "force-dynamic";

export const POST = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  const modelsDevId = typeof body.modelsDevId === "string" ? body.modelsDevId : "";
  if (!model || !modelsDevId) {
    return NextResponse.json(
      { success: false, error: "model and modelsDevId are required" },
      { status: 400 }
    );
  }

  // 候选必须存在于快照中（防篡改：价格以快照为准，不接受客户端传入价格）
  const snapshot = await getSnapshot();
  const { candidates } = snapshot ? matchModelsDevModel(model, snapshot.data) : { candidates: [] };
  const candidate = candidates.find((c) => c.modelsDevId === modelsDevId);
  if (!candidate) {
    return NextResponse.json(
      { success: false, error: "Candidate not found in models.dev snapshot" },
      { status: 404 }
    );
  }

  await selectModelsDevPrice({
    model,
    modelsDevId: candidate.modelsDevId,
    inputPrice: candidate.inputPrice,
    outputPrice: candidate.outputPrice,
    cacheReadPrice: candidate.cacheReadPrice,
    cacheWritePrice: candidate.cacheWritePrice,
  });
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "model_price_selected",
    targetType: "system",
    ip,
    userAgent,
    details: { model, modelsDevId },
  });
  return NextResponse.json({ success: true });
});
