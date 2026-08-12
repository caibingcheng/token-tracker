import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { selectModelsDevPrice } from "@/lib/model-prices-service";
import { getSnapshot, isFiniteNonNegative } from "@/lib/models-dev/snapshot";

// 从候选选定价格落库（source='models.dev'，记录 models_dev_id）。
// 校验：modelsDevId 必须存在于快照（防篡改，价格以快照为准，不接受客户端传入价格）。
// 不限定匹配管线候选 —— 允许 Price Picker 搜索选中任意快照条目。

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

  // 快照直查：解析 providerId/modelId，校验条目存在，价格以快照为准
  const slash = modelsDevId.indexOf("/");
  if (slash <= 0) {
    return NextResponse.json(
      { success: false, error: "Candidate not found in models.dev snapshot" },
      { status: 404 }
    );
  }
  const providerId = modelsDevId.slice(0, slash);
  const modelId = modelsDevId.slice(slash + 1);
  const snapshot = await getSnapshot();
  const target = snapshot?.data[providerId]?.models[modelId];
  if (!target?.cost) {
    return NextResponse.json(
      { success: false, error: "Candidate not found in models.dev snapshot" },
      { status: 404 }
    );
  }

  const cost = target.cost;
  await selectModelsDevPrice({
    model,
    modelsDevId,
    inputPrice: isFiniteNonNegative(cost.input) ? cost.input : 0,
    outputPrice: isFiniteNonNegative(cost.output) ? cost.output : 0,
    cacheReadPrice: isFiniteNonNegative(cost.cache_read)
      ? cost.cache_read
      : null,
    cacheWritePrice: isFiniteNonNegative(cost.cache_write)
      ? cost.cache_write
      : null,
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
