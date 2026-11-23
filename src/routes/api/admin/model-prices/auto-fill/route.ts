import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { autoFillAllUnpriced, autoFillForceAll } from "@/lib/model-prices-service";
import { loadModelsDevSource } from "@/lib/auth/settings-models-dev-source";

// 批量自动填充：
// - fill（默认）：只填空行不覆盖（Auto-fill unmatched）
// - force：覆盖所有非 manual 已定价行（Re-fill all），manual 行绝不触碰

export const dynamic = "force-dynamic";

export const POST = withAuth(async (request: NextRequest) => {
  let mode = "fill";
  try {
    const body = await request.json();
    if (body && typeof body === "object" && typeof (body as any).mode === "string") {
      mode = (body as any).mode;
    }
  } catch {
    // 无 body / 非法 JSON → 缺省 fill（向后兼容）
  }
  if (mode !== "fill" && mode !== "force") {
    return NextResponse.json(
      { success: false, error: "mode must be 'fill' or 'force'" },
      { status: 400 }
    );
  }

  const result =
    mode === "force" ? await autoFillForceAll() : await autoFillAllUnpriced();
  const source = await loadModelsDevSource();
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "model_price_auto_fill",
    targetType: "system",
    ip,
    userAgent,
    details: {
      mode,
      source,
      filled: result.filled.length,
      updated: result.updated.length,
      unmatched: result.unmatched.length,
    },
  });
  return NextResponse.json({ success: true, data: result });
});
