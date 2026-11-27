// relay 运行统计（会话 token）：待授权配对数、预留泄漏计数、plan/report 速率。
import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { getDeviceStats } from "@/lib/device/store";

export const GET = withAuth(async () => {
  const data = await getDeviceStats();
  return NextResponse.json({ success: true, data });
});
