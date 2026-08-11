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
import { getTokenEpoch, getAdminApiKey, getEnvAdminKeys, resolveSessionTtlMs } from "./settings";

export type RouteHandler = (
  request: NextRequest,
  ctx: { params: Record<string, string> }
) => Promise<Response> | Response;

export function unauthorized(message = "Invalid or missing session token") {
  return NextResponse.json({ success: false, error: message }, { status: 401 });
}

// 当前生效的候选登录 key：DB key 优先（单值），env ADMIN_API_KEY / API_KEYS 仅 bootstrap 兜底（可多个）
export async function resolveCandidateLoginKeys(): Promise<string[]> {
  const dbKey = await getAdminApiKey();
  if (dbKey !== null) return [dbKey];
  return getEnvAdminKeys();
}

// 校验 token 的 keyId 指纹是否命中任一候选 key（登录可能用任一 env key 签发）
export async function matchesActiveLoginKey(keyId: string): Promise<boolean> {
  const keys = await resolveCandidateLoginKeys();
  return keys.some((k) => safeCompare(keyId, keyFingerprint(k)));
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

    // 登录 key 指纹校验：修改 key 后旧 token 立即失效（遍历候选 key，覆盖多 env key 场景）
    if (!(await matchesActiveLoginKey(payload.keyId))) {
      return unauthorized();
    }

    const response = await handler(request, ctx);

    // 滑动续期：剩余有效期不足一半时签发新 token
    const ttlMs = await resolveSessionTtlMs();
    if (response instanceof NextResponse) {
      if (shouldRenewToken(payload, ttlMs)) {
        response.headers.set(
          "X-Session-Token",
          signSessionToken(epoch, payload.keyId, ttlMs)
        );
      }
    } else {
      // 普通 Response：包装并附带续期 header
      if (shouldRenewToken(payload, ttlMs)) {
        const wrapped = new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        });
        wrapped.headers.set(
          "X-Session-Token",
          signSessionToken(epoch, payload.keyId, ttlMs)
        );
        return wrapped;
      }
    }

    return response;
  };
}
