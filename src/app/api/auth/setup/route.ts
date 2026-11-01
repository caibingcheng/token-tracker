import { NextRequest, NextResponse } from "next/server";
import {
  canRunSetup,
  runSetup,
  SetupNotAllowedError,
  checkSetupRateLimit,
} from "@/lib/auth/setup";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { getRateLimitKey } from "@/lib/net/client-ip";
import { canBypassAuth } from "@/lib/auth/local-bypass";
import { resolveSessionTtlMs } from "@/lib/auth/settings";
import {
  readJsonBodyLimited,
  BodyTooLargeError,
  InvalidJsonBodyError,
} from "@/lib/auth/request-body";
import { buildSessionCookie, shouldSecureCookie } from "@/lib/auth/session-cookie";

export async function GET(request: NextRequest) {
  // authDisabled：本地免密码直通生效时前端跳过登录/设置向导直接进入
  const authDisabled = canBypassAuth(request);
  return NextResponse.json({
    setupRequired: authDisabled ? false : await canRunSetup(),
    authDisabled,
  });
}

export async function POST(request: NextRequest) {
  // 限流必须最先执行：缺 key / 坏 JSON / 超大 body 都不能绕过限流
  if (checkSetupRateLimit(getRateLimitKey(request))) {
    return NextResponse.json(
      { success: false, error: "Too many attempts, try again later" },
      { status: 429 }
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await readJsonBodyLimited(request);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return NextResponse.json(
        { success: false, error: "Request body too large" },
        { status: 413 }
      );
    }
    if (err instanceof InvalidJsonBodyError) {
      return NextResponse.json(
        { success: false, error: "Invalid JSON body" },
        { status: 400 }
      );
    }
    throw err;
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ success: false, error: "Missing apiKey" }, { status: 400 });
  }

  try {
    const token = await runSetup(apiKey);
    const { ip: auditIp, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "setup_admin_key",
      targetType: "system",
      ip: auditIp,
      userAgent,
      details: { keyLength: apiKey.length },
    });
    // httpOnly cookie 下发浏览器登录态（同 login）；body 明文 token 保留给脚本。
    // Max-Age 用 resolveSessionTtlMs() 与 runSetup 内部签发 TTL 保持一致
    const res = NextResponse.json({ success: true, token });
    res.headers.append(
      "Set-Cookie",
      buildSessionCookie(
        token,
        await resolveSessionTtlMs(),
        shouldSecureCookie(request.url)
      )
    );
    return res;
  } catch (err) {
    if (err instanceof SetupNotAllowedError) {
      return NextResponse.json(
        { success: false, error: "Setup is no longer allowed" },
        { status: 403 }
      );
    }
    console.error("[setup] unexpected error:", err);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
