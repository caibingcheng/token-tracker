// 设备列表 + 配对授权/拒绝（会话 token）。
//
// GET   列表（含 30 天记录数）
// POST  {code, action: "authorize" | "deny", name?} —— 「输码 → 看设备 → 授权」的第二步。
//       授权只登记 devices 行并把配对会话置 authorized；token 由 relay 的下一次 poll 取走。
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { invalidateQueryCache } from "@/lib/db/cache";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import {
  readJsonBodyLimited,
  BodyTooLargeError,
  InvalidJsonBodyError,
} from "@/lib/auth/request-body";
import { authorizePairing, denyPairing, listDevices } from "@/lib/device/store";
import { sanitizeDeviceName } from "@/lib/device/pairing";

export const GET = withAuth(async () => {
  const data = await listDevices();
  return NextResponse.json({ success: true, data });
});

export const POST = withAuth(async (request: NextRequest) => {
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
  const code = typeof body.code === "string" ? body.code : "";
  const pairingId =
    typeof body.pairingId === "string" && body.pairingId !== "" ? body.pairingId.slice(0, 64) : undefined;
  const action = body.action === "deny" ? "deny" : "authorize";
  const { ip, userAgent } = extractClientInfo(request);
  if (!code && !pairingId) {
    return NextResponse.json({ success: false, error: "code or pairingId is required" }, { status: 400 });
  }

  if (action === "deny") {
    const ok = await denyPairing({ code, pairingId });
    if (!ok) {
      return NextResponse.json(
        { success: false, error: "Unknown or expired pairing code" },
        { status: 404 }
      );
    }
    await recordAuditLog({
      action: "device_pairing_denied",
      targetType: "device",
      ip,
      userAgent,
      // 不记码/不记 code_hash：只说拒绝了哪台设备
      details: { pairingSource: pairingId ? "list" : "code" },
    });
    invalidateQueryCache();
    return NextResponse.json({ success: true });
  }

  const name = typeof body.name === "string" ? sanitizeDeviceName(body.name, "relay") : undefined;
  const result = await authorizePairing({ code, pairingId, name });
  if (!result.ok) {
    return NextResponse.json(
      {
        success: false,
        error:
          result.reason === "not_pending"
            ? "Pairing session is no longer pending"
            : "Unknown or expired pairing code",
      },
      { status: 404 }
    );
  }
  await recordAuditLog({
    action: "device_paired",
    targetType: "device",
    targetId: result.deviceId,
    ip,
    userAgent,
    details: { fingerprint: result.fingerprint, name: result.name, reauth: result.reauth },
  });
  invalidateQueryCache();
  return NextResponse.json({
    success: true,
    data: {
      deviceId: result.deviceId,
      fingerprint: result.fingerprint,
      name: result.name,
      reauth: result.reauth,
    },
  });
});
