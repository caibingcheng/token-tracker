// 设备改名 / 撤销 / 解除撤销 / 删除（会话 token）。
import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { invalidateQueryCache } from "@/lib/db/cache";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import {
  deleteDevice,
  listDevices,
  renameDevice,
  setDeviceRevoked,
} from "@/lib/device/store";
import { sanitizeDeviceName } from "@/lib/device/pairing";

function parseId(raw: string): number | null {
  const n = Number(raw);
  return Number.isInteger(n) && n > 0 ? n : null;
}

interface Params {
  params: Promise<{ id: string }>;
}

export const PATCH = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  const paramsResolved = await params;
  const id = parseId(paramsResolved.id);
  if (id === null) {
    return NextResponse.json({ success: false, error: "Invalid device id" }, { status: 400 });
  }
  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  const { ip, userAgent } = extractClientInfo(request);
  const before = (await listDevices()).find((d) => d.id === id);
  if (!before) {
    return NextResponse.json({ success: false, error: "Device not found" }, { status: 404 });
  }

  let changed = false;
  if (typeof body.name === "string") {
    const next = sanitizeDeviceName(body.name, "relay");
    if (next !== before.name) {
      await renameDevice(id, next);
      await recordAuditLog({
        action: "device_renamed",
        targetType: "device",
        targetId: id,
        ip,
        userAgent,
        details: { from: before.name, to: next },
      });
      changed = true;
    }
  }
  if (typeof body.revoked === "boolean") {
    const revoked = body.revoked;
    const isRevoked = before.revokedAt !== null;
    if (revoked !== isRevoked) {
      await setDeviceRevoked(id, revoked);
      await recordAuditLog({
        action: revoked ? "device_revoked" : "device_unrevoked",
        targetType: "device",
        targetId: id,
        ip,
        userAgent,
        details: revoked
          ? { fingerprint: before.fingerprint, name: before.name }
          : { fingerprint: before.fingerprint },
      });
      changed = true;
    }
  }
  if (!changed) {
    return NextResponse.json({ success: false, error: "Nothing to update" }, { status: 400 });
  }
  invalidateQueryCache();
  return NextResponse.json({ success: true });
});

export const DELETE = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  const paramsResolved = await params;
  const id = parseId(paramsResolved.id);
  if (id === null) {
    return NextResponse.json({ success: false, error: "Invalid device id" }, { status: 400 });
  }
  const removed = await deleteDevice(id);
  if (!removed) {
    return NextResponse.json({ success: false, error: "Device not found" }, { status: 404 });
  }
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "device_deleted",
    targetType: "device",
    targetId: id,
    ip,
    userAgent,
    details: {
      fingerprint: removed.fingerprint,
      name: removed.name,
      plansDeleted: removed.plansDeleted,
    },
  });
  invalidateQueryCache();
  return NextResponse.json({ success: true });
});
