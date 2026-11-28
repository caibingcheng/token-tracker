// relay 配对：码申请（RFC 8628 device authorization grant 的第一步）。
// 公开端点（无凭证）—— 三处登记见 docs/agents/api-routes.md + guard-scan + verify-session。
// 防滥用：限流先于读 body（与 auth/login 同口径）+ 每 IP 同时存在的 pending 会话上限。
import { NextRequest, NextResponse } from "next/server";
import { getRateLimitKey } from "@/lib/net/client-ip";
import {
  readJsonBodyLimited,
  BodyTooLargeError,
  InvalidJsonBodyError,
} from "@/lib/auth/request-body";
import { createSlidingWindowLimiter } from "@/lib/device/rate-limit";
import { PairingLimitError, startPairing } from "@/lib/device/store";
import { sanitizeDeviceName } from "@/lib/device/pairing";

// 每 IP 15 分钟内最多发起 10 次配对（正常只需 1 次；重试成本很低）
const limiter = createSlidingWindowLimiter({ windowMs: 15 * 60 * 1000, max: 10 });

const FINGERPRINT_RE = /^u-[a-f0-9]{32}$/;

export async function POST(request: NextRequest) {
  // 限流先于读 body：缺字段 / 坏 JSON / 超大 body 同样计数
  if (limiter.hit(getRateLimitKey(request))) {
    return NextResponse.json(
      { success: false, error: "Too many pairing attempts, try again later" },
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

  const fingerprint = typeof body.fingerprint === "string" ? body.fingerprint.trim() : "";
  if (!FINGERPRINT_RE.test(fingerprint)) {
    return NextResponse.json(
      { success: false, error: "fingerprint must look like u-<32 hex>" },
      { status: 400 }
    );
  }
  const publicKey = typeof body.publicKey === "string" ? body.publicKey.trim() : "";
  // X25519 SPKI DER = 44 字节 → base64url 59 字符；允许 32..128 的宽松范围
  if (!/^[A-Za-z0-9_-]{32,128}$/.test(publicKey)) {
    return NextResponse.json(
      { success: false, error: "publicKey must be base64url" },
      { status: 400 }
    );
  }
  const clientSecret = typeof body.clientSecret === "string" ? body.clientSecret : "";
  if (clientSecret.length < 16 || clientSecret.length > 128) {
    return NextResponse.json(
      { success: false, error: "clientSecret must be 16..128 chars" },
      { status: 400 }
    );
  }
  const name = sanitizeDeviceName(body.name, "relay");
  const rawUA = request.headers.get("user-agent");
  const userAgent = rawUA && rawUA.trim() !== "" ? rawUA.slice(0, 512) : null;

  try {
    const result = await startPairing({
      fingerprint,
      name,
      publicKey,
      clientSecret,
      clientIp: getRateLimitKey(request),
      userAgent,
    });
    return NextResponse.json(
      {
        success: true,
        data: {
          code: result.code,
          expiresIn: result.expiresIn,
          interval: result.interval,
        },
      },
      { headers: { "cache-control": "no-store" } }
    );
  } catch (err) {
    if (err instanceof PairingLimitError) {
      return NextResponse.json(
        { success: false, error: "Too many pending pairing sessions from this address" },
        { status: 429 }
      );
    }
    throw err;
  }
}
