import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { safeCompare } from "@/lib/gateway/crypto";
import {
  verifySessionToken,
  isTokenExpired,
  shouldRenewToken,
  signSessionToken,
  keyFingerprint,
} from "./session";
import { getTokenEpoch, getAdminApiKey } from "./settings";

export type RouteHandler = (
  request: NextRequest,
  ctx: { params: Record<string, string> }
) => Promise<Response> | Response;

export function unauthorized(message = "Invalid or missing session token") {
  return NextResponse.json({ success: false, error: message }, { status: 401 });
}

// 当前生效的登录 key：DB 优先，env API_KEYS 仅 bootstrap 兜底
export async function resolveActiveLoginKey(): Promise<string | null> {
  const dbKey = await getAdminApiKey();
  if (dbKey !== null) return dbKey;
  const envKeys =
    process.env.API_KEYS?.split(",")
      .map((k) => k.trim())
      .filter(Boolean) ?? [];
  return envKeys.length > 0 ? envKeys[0]! : null;
}

// 路由内认证（第二层）：会话 token 验签 + exp + epoch 检查 + 登录 key 指纹校验；
// 认证通过且 token 剩余有效期不足一半时，通过 X-Session-Token 响应头下发新 token（滑动续期）
export function withAuth(handler: RouteHandler): RouteHandler {
  return async (request, ctx) => {
    const token = request.headers.get("X-API-Key");
    if (!token) return unauthorized();

    const payload = verifySessionToken(token);
    if (!payload || isTokenExpired(payload)) return unauthorized();

    // epoch 检查（middleware 无法访问 DB，必须留在这里）
    const epoch = await getTokenEpoch();
    if (payload.epoch !== epoch) return unauthorized();

    // 登录 key 指纹校验：修改 key 后旧 token 立即失效
    const activeKey = await resolveActiveLoginKey();
    if (!activeKey) return unauthorized();
    if (!safeCompare(payload.keyId, keyFingerprint(activeKey))) {
      return unauthorized();
    }

    const response = await handler(request, ctx);

    // 滑动续期：剩余有效期不足一半时签发新 token
    if (response instanceof NextResponse) {
      if (shouldRenewToken(payload)) {
        response.headers.set(
          "X-Session-Token",
          signSessionToken(epoch, payload.keyId)
        );
      }
    } else {
      // 普通 Response：包装并附带续期 header
      if (shouldRenewToken(payload)) {
        const wrapped = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        wrapped.headers.set(
          "X-Session-Token",
          signSessionToken(epoch, payload.keyId)
        );
        return wrapped;
      }
    }

    return response;
  };
}
