import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamKeysTable, devicesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

interface Params {
  params: Promise<{ id: string; keyId: string }>;
}

export const PATCH = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params; // params 为 Promise（Next 15+ 动态路由）
  const paramsResolved = await params;
  return withSkipCache(async () => {
    await initDatabase();
    const keyId = Number(paramsResolved.keyId);
    const row = (
      await db.select().from(upstreamKeysTable).where(eq(upstreamKeysTable.id, keyId))
    )[0];
    if (!row) {
      return NextResponse.json({ success: false, error: "Upstream key not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const values: Record<string, unknown> = {};
    if (body.enabled !== undefined) {
      values.enabled = body.enabled ? 1 : 0;
    }
    if (body.lastStatus !== undefined) {
      values.lastStatus = typeof body.lastStatus === "string" ? body.lastStatus : null;
    }
    // per-device key 归属可改（null = 改回通用 key）
    if (body.deviceId !== undefined) {
      if (body.deviceId === null) {
        values.deviceId = null;
      } else {
        const deviceId = Number(body.deviceId);
        if (!Number.isInteger(deviceId) || deviceId <= 0) {
          return NextResponse.json(
            { success: false, error: "deviceId must be a positive integer or null" },
            { status: 400 }
          );
        }
        const device = await db
          .select({ id: devicesTable.id })
          .from(devicesTable)
          .where(eq(devicesTable.id, deviceId));
        if (device.length === 0) {
          return NextResponse.json({ success: false, error: "Device not found" }, { status: 404 });
        }
        values.deviceId = deviceId;
      }
    }
    if (Object.keys(values).length === 0) {
      return NextResponse.json({ success: false, error: "No fields to update" }, { status: 400 });
    }

    await db.update(upstreamKeysTable).set(values).where(eq(upstreamKeysTable.id, keyId));
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "upstream_key_updated",
      targetType: "upstream_key",
      targetId: keyId,
      ip,
      userAgent,
      details: {
        upstreamId: row.upstreamId,
        changed: Object.keys(values),
        ...(body.deviceId !== undefined
          ? { deviceId: values.deviceId ?? null, previousDeviceId: row.deviceId ?? null }
          : {}),
      },
    });
    return NextResponse.json({ success: true });
  });
});

export const DELETE = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params; // params 为 Promise（Next 15+ 动态路由）
  const paramsResolved = await params;
  return withSkipCache(async () => {
    await initDatabase();
    const keyId = Number(paramsResolved.keyId);
    const row = (
      await db.select().from(upstreamKeysTable).where(eq(upstreamKeysTable.id, keyId))
    )[0];
    if (!row) {
      return NextResponse.json({ success: false, error: "Upstream key not found" }, { status: 404 });
    }
    await db.delete(upstreamKeysTable).where(eq(upstreamKeysTable.id, keyId));
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "upstream_key_deleted",
      targetType: "upstream_key",
      targetId: keyId,
      ip,
      userAgent,
      details: { upstreamId: row.upstreamId },
    });
    return NextResponse.json({ success: true });
  });
});
