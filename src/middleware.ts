import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

export function middleware(request: NextRequest) {
  // 对 /api/ingest（写入操作）和 /api/records（读取操作）进行认证
  if (
    !request.nextUrl.pathname.startsWith("/api/ingest") &&
    !request.nextUrl.pathname.startsWith("/api/records")
  ) {
    return NextResponse.next();
  }

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
