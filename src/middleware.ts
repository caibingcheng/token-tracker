import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

// 全站认证：
// - /api/*（统计 + admin）要求 X-API-Key（env API_KEYS）
// - /v1/*、/v1beta/*（网关代理入口）由虚拟 key 认证，不在此处拦截
// - 页面（/、/admin）不经 middleware 拦截，由客户端 ApiKeyGate 处理
export function middleware(request: NextRequest) {
  const apiKey = request.headers.get("X-API-Key");
  const validKeys = process.env.API_KEYS?.split(",").map((k) => k.trim()) || [];

  if (!apiKey || !validKeys.includes(apiKey)) {
    return NextResponse.json(
      { success: false, error: "Invalid or missing API Key" },
      { status: 401 }
    );
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
