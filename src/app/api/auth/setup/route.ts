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
import {
  readJsonBodyLimited,
  BodyTooLargeError,
  InvalidJsonBodyError,
} from "@/lib/auth/request-body";

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
    return NextResponse.json({ success: true, token });
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
