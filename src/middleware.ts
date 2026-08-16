import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import {
  deriveEdgeSessionKey,
  verifyEdgeSignature,
  parseEdgeSessionPayload,
} from "@/lib/auth/edge-verify";

// 验签 middleware（第一层防漏）：Edge runtime 无法访问 SQLite / node:crypto，
// 因此这里只用 WebCrypto 验证会话 token 的 HMAC-SHA256 签名 + exp 过期检查；
// epoch 检查与 DB key 校验由路由内 withAuth 完成。
// matcher 排除 /api/auth/login 与 /api/auth/setup：login 携带原始 API key，
// setup 是首次启动的 fail-open 入口（自身闸门校验），两者均无会话 token 可用。

function unauthorized() {
  return NextResponse.json(
    { success: false, error: "Invalid or missing session token" },
    { status: 401 }
  );
}

export async function middleware(request: NextRequest) {
  const token = request.headers.get("X-API-Key");
  if (!token) return unauthorized();

  const dot = token.indexOf(".");
  if (dot <= 0) return unauthorized();
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const secret = process.env.GATEWAY_SECRET;
  if (!secret) {
    return NextResponse.json(
      { success: false, error: "GATEWAY_SECRET is not configured" },
      { status: 503 }
    );
  }

  const key = await deriveEdgeSessionKey(secret);
  if (!(await verifyEdgeSignature(key, payload, sig))) {
    return unauthorized();
  }
  if (!parseEdgeSessionPayload(payload)) {
    return unauthorized();
  }

  return NextResponse.next();
}

export const config = {
  matcher: "/api/((?!auth/login|auth/setup).*)",
};
