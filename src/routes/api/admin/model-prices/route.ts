import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import {
  getModelPricesList,
  upsertManualPrice,
  deleteModelPrice,
} from "@/lib/model-prices-service";

// model_prices 管理：GET 行集（upstream models ∪ 已定价，附徽标状态）、
// PUT 手动编辑（source='manual'）、DELETE 删除（model 走 query，避免 / 编码问题）

export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  try {
    const rows = await getModelPricesList();
    return NextResponse.json({ success: true, data: rows });
  } catch (error) {
    console.error("model-prices list error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
});

export const PUT = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const model = typeof body.model === "string" ? body.model.trim() : "";
  if (!model) {
    return NextResponse.json({ success: false, error: "model is required" }, { status: 400 });
  }
  const inputPrice = Number(body.inputPrice);
  const outputPrice = Number(body.outputPrice);
  if (!Number.isFinite(inputPrice) || inputPrice < 0 || !Number.isFinite(outputPrice) || outputPrice < 0) {
    return NextResponse.json(
      { success: false, error: "inputPrice and outputPrice must be non-negative numbers" },
      { status: 400 }
    );
  }
  const parseOptional = (v: unknown): number | null => {
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n < 0) {
      throw new Error("invalid optional price");
    }
    return n;
  };
  let cacheReadPrice: number | null;
  let cacheWritePrice: number | null;
  try {
    cacheReadPrice = parseOptional(body.cacheReadPrice);
    cacheWritePrice = parseOptional(body.cacheWritePrice);
  } catch {
    return NextResponse.json(
      { success: false, error: "cacheReadPrice/cacheWritePrice must be non-negative numbers or null" },
      { status: 400 }
    );
  }

  await upsertManualPrice({
    model,
    inputPrice,
    outputPrice,
    cacheReadPrice,
    cacheWritePrice,
  });
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "model_price_updated",
    targetType: "system",
    ip,
    userAgent,
    details: { model, inputPrice, outputPrice },
  });
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (request: NextRequest) => {
  const model = new URL(request.url).searchParams.get("model") ?? "";
  if (!model) {
    return NextResponse.json({ success: false, error: "model query parameter is required" }, { status: 400 });
  }
  const deleted = await deleteModelPrice(model);
  if (!deleted) {
    return NextResponse.json({ success: false, error: "Model price not found" }, { status: 404 });
  }
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "model_price_deleted",
    targetType: "system",
    ip,
    userAgent,
    details: { model },
  });
  return NextResponse.json({ success: true });
});
