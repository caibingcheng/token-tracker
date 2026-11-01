import { NextRequest, NextResponse } from "next/server";
import { buildClearSessionCookie, shouldSecureCookie } from "@/lib/auth/session-cookie";

// 登出：过期 Set-Cookie 吊销浏览器登录态。会话 token 无状态，删 cookie 即结束本会话；
// 全局吊销（所有设备）走 /api/admin/auth/sessions 的 epoch+1。
// 不验签：cookie 可能已过期，带不带有效 token 都必须能到达这里清掉它
export async function POST(request: NextRequest) {
  const res = NextResponse.json({ success: true });
  res.headers.append(
    "Set-Cookie",
    buildClearSessionCookie(shouldSecureCookie(request.url))
  );
  return res;
}
