// 待授权配对会话列表（会话 token）：/admin/devices 的预检列表。
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { listPendingPairings } from "@/lib/device/store";

export const GET = withAuth(async () => {
  const data = await listPendingPairings();
  return NextResponse.json({ success: true, data });
});
