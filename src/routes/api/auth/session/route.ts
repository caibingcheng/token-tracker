import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";

// 登录态探测：ApiKeyGate 首帧用它区分「cookie 有效（已登录）」与「未登录」——
// httpOnly cookie 前端 JS 读不到，只能探。200 = 已登录；401 = 未登录（proxy 会顺带清掉失效 cookie）
export const GET = withAuth(async () =>
  NextResponse.json({ authenticated: true })
);
