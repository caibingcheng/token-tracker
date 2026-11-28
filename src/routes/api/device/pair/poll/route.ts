// relay 配对：轮询取 token（RFC 8628 的 token 请求）。
// 公开端点（无凭证）：靠 8 位码 + clientSecret 自校验；未知码/错 secret 一律 428（防枚举）。
import { NextRequest, NextResponse } from "next/server";
import { getRateLimitKey } from "@/lib/net/client-ip";
import {
  readJsonBodyLimited,
  BodyTooLargeError,
  InvalidJsonBodyError,
} from "@/lib/auth/request-body";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { createSlidingWindowLimiter } from "@/lib/device/rate-limit";
import { normalizePairingCode, pairingCodeHash } from "@/lib/device/pairing";
import { pollPairing } from "@/lib/device/store";

// 码级限流（RFC 8628 的 interval 由 poll 响应的 slow_down 另外表达；这里是硬上限）
const limiter = createSlidingWindowLimiter({ windowMs: 60 * 1000, max: 60 });

// 来源地址前置限流：必须在读 body 之前扣配额，否则未认证者可用超限/坏 JSON body
// 无限投递而不消耗任何 token。码级桶保持原语义（只在本层做粗粒度封顶）。
const ipLimiter = createSlidingWindowLimiter({ windowMs: 60 * 1000, max: 120 });

export async function POST(request: NextRequest) {
  if (ipLimiter.hit(`ip:${getRateLimitKey(request)}`)) {
    return NextResponse.json(
      { success: false, error: "slow_down", interval: 30 },
      { status: 429 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyLimited(request);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json({ success: false, error: "Request body too large" }, { status: 413 });
    }
    if (err instanceof InvalidJsonBodyError) {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }
    throw err;
  }

  const rawCode = typeof body.code === "string" ? body.code : "";
  const normalized = normalizePairingCode(rawCode);
  // 无效码没有 code_hash 可用：降到按来源地址限流
  const limitKey = normalized ? pairingCodeHash(normalized) : `ip:${getRateLimitKey(request)}`;
  if (limiter.hit(limitKey)) {
    return NextResponse.json(
      { success: false, error: "slow_down", interval: 30 },
      { status: 429 }
    );
  }

  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
  if (!normalized || clientSecret === "") {
    return NextResponse.json(
      { success: false, error: "authorization_pending" },
      { status: 428 }
    );
  }

  const { ip, userAgent } = extractClientInfo(request);
  const result = await pollPairing({ code: normalized, clientSecret, clientIp: ip, userAgent });

  switch (result.state) {
    case "authorized":
      await recordAuditLog({
        action: "device_paired",
        targetType: "device",
        targetId: result.deviceId,
        ip,
        userAgent,
        // reauth 与否由调用侧（authorize）已知；poll 只记首次领取 token 的事实
        details: { fingerprint: result.fingerprint, name: result.name },
      });
      return NextResponse.json(
        {
          success: true,
          data: {
            status: "authorized",
            token: result.token,
            deviceId: result.deviceId,
            name: result.name,
          },
        },
        { headers: { "cache-control": "no-store" } }
      );
    case "slow_down":
      return NextResponse.json(
        { success: false, error: "slow_down", interval: result.interval },
        { status: 429 }
      );
    case "pending":
    case "unknown":
      return NextResponse.json(
        { success: false, error: "authorization_pending" },
        { status: 428 }
      );
    case "denied":
      return NextResponse.json({ success: false, error: "access_denied" }, { status: 400 });
    case "expired":
      return NextResponse.json({ success: false, error: "expired_token" }, { status: 400 });
  }
}
