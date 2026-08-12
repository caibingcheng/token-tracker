import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { autoFillAllUnpriced } from "@/lib/model-prices-service";

// 批量自动填充所有未定价行（只填空不覆盖）

export const dynamic = "force-dynamic";

export const POST = withAuth(async (request: NextRequest) => {
  const result = await autoFillAllUnpriced();
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "model_price_auto_fill",
    targetType: "system",
    ip,
    userAgent,
    details: { filled: result.filled.length, unmatched: result.unmatched.length },
  });
  return NextResponse.json({ success: true, data: result });
});
