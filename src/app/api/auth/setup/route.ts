import { NextRequest, NextResponse } from "next/server";
import {
  canRunSetup,
  runSetup,
  SetupNotAllowedError,
  isValidSetupKey,
  checkSetupRateLimit,
} from "@/lib/auth/setup";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

export async function GET() {
  return NextResponse.json({ setupRequired: await canRunSetup() });
}

export async function POST(request: NextRequest) {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
  if (!apiKey) {
    return NextResponse.json({ success: false, error: "Missing apiKey" }, { status: 400 });
  }
  // 密钥强度校验：≥16 字符
  if (!isValidSetupKey(apiKey)) {
    return NextResponse.json(
      { success: false, error: "apiKey must be at least 16 characters" },
      { status: 400 }
    );
  }

  const { ip } = extractClientInfo(request);
  if (checkSetupRateLimit(`${ip}:setup`)) {
    return NextResponse.json(
      { success: false, error: "Too many attempts, try again later" },
      { status: 429 }
    );
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
