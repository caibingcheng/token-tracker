// relay 设备凭证中间件（与 withAuth 平行、不复用：会话 token 与 device token 是两套凭证）。
//
// 约定：
// - 只接受 `Authorization: Bearer dt-…`（header 认证；不接受 query）
// - **每次直读 DB**（withSkipCache），revoke 立即生效（不进查询缓存）
// - 不读 GATEWAY_SECRET、不解会话 token、不校 token_epoch
// - last_seen_at 异步更新（fire-and-forget，不阻塞响应）
import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { deviceTokenHash, isDeviceTokenShaped } from "@/lib/device/pairing";
import { getDeviceByTokenHash, touchDeviceLastSeen } from "@/lib/device/store";

export interface DeviceContext {
  id: number;
  fingerprint: string;
  name: string | null;
  lastSeenAt: string | null;
  publicKey: string;
}

export type DeviceHandler = (
  request: NextRequest,
  device: DeviceContext
) => Promise<Response> | Response;

export function invalidDeviceToken(message = "Invalid or revoked device token") {
  return NextResponse.json({ success: false, error: message }, { status: 401 });
}

function extractBearerToken(request: Request): string | null {
  const authorization = request.headers.get("authorization");
  if (!authorization) return null;
  const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
  if (!match) return null;
  const token = match[1]!.trim();
  return token === "" ? null : token;
}

export function withDeviceAuth(handler: DeviceHandler): (request: NextRequest) => Promise<Response> {
  return async (request) => {
    const token = extractBearerToken(request);
    if (!token || !isDeviceTokenShaped(token)) return invalidDeviceToken();

    const device = await getDeviceByTokenHash(deviceTokenHash(token));
    if (!device || device.revokedAt) return invalidDeviceToken();

    // fire-and-forget：只用于列表展示，失败不影响请求
    touchDeviceLastSeen(device.id).catch(() => {});

    return handler(request, {
      id: device.id,
      fingerprint: device.fingerprint,
      name: device.name ?? null,
      lastSeenAt: device.lastSeenAt ?? null,
      publicKey: device.publicKey,
    });
  };
}
