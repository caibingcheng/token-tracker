// 轮换 device token（会话 token）：旧 token 立即失效，明文只返回这一次。
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { invalidateQueryCache } from "@/lib/db/cache";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { rotateDeviceToken } from "@/lib/device/store";

interface Params {
  params: Promise<{ id: string }>;
}

export const POST = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  const paramsResolved = await params;
  const id = Number(paramsResolved.id);
  if (!Number.isInteger(id) || id <= 0) {
    return NextResponse.json({ success: false, error: "Invalid device id" }, { status: 400 });
  }
  const rotated = await rotateDeviceToken(id);
  if (!rotated) {
    return NextResponse.json({ success: false, error: "Device not found" }, { status: 404 });
  }
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "device_token_rotated",
    targetType: "device",
    targetId: id,
    ip,
    userAgent,
    details: {},
  });
  invalidateQueryCache();
  return NextResponse.json({ success: true, data: { token: rotated.token } });
});
