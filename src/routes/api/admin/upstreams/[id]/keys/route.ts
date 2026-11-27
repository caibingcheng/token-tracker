import { NextRequest, NextResponse } from "next/server";
import { eq, inArray } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable, devicesTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { encryptSecret, decryptSecret, GatewaySecretMissingError } from "@/lib/gateway/crypto";
import { computeKeyHint, formatMaskedKey } from "@/lib/gateway/key-hint";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

// 掩码现算（不落库）：解密 → 脱敏提示位。
// 缺 master key 属配置错误：上抛给 GET 统一 503（AGENTS 红线「GATEWAY_SECRET 缺失时
// admin API 返回 503，不静默降级」）；单行密文损坏（换过 secret / 被篡改）只影响该行，
// 回落 key #<id>，不阻塞列表也不回显失败原因。
function maskStoredKey(row: any): string {
  try {
    return formatMaskedKey(computeKeyHint(decryptSecret(row.apiKeyEncrypted)), row.id);
  } catch (err) {
    if (err instanceof GatewaySecretMissingError) throw err;
    return formatMaskedKey(null, row.id);
  }
}

function gatewaySecretError() {
  return NextResponse.json(
    { success: false, error: "GATEWAY_SECRET is not configured" },
    { status: 503 }
  );
}

// deviceId 归一：null/缺省 = 通用 key；非正整数或非整数 → 400
function parseDeviceId(value: unknown): number | null | Error {
  if (value === undefined || value === null) return null;
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    return new Error("deviceId must be a positive integer or null");
  }
  return n;
}

async function deviceExists(deviceId: number): Promise<boolean> {
  const rows = await db
    .select({ id: devicesTable.id })
    .from(devicesTable)
    .where(eq(devicesTable.id, deviceId));
  return rows.length > 0;
}

interface Params {
  params: Promise<{ id: string }>;
}

export const GET = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params; // params 为 Promise（Next 15+ 动态路由）
  const paramsResolved = await params;
  return withSkipCache(async () => {
    await initDatabase();
    const upstreamId = Number(paramsResolved.id);
    const rows = await db
      .select()
      .from(upstreamKeysTable)
      .where(eq(upstreamKeysTable.upstreamId, upstreamId))
      .orderBy(upstreamKeysTable.id);
    // per-device key（upstream_keys.device_id 非空）：只下发给对应 relay，直连/探活/分类器不用
    const deviceIds = [
      ...new Set(
        rows.map((k: any) => k.deviceId).filter((id: any): id is number => typeof id === "number")
      ),
    ];
    const deviceNames = new Map<number, string>();
    if (deviceIds.length > 0) {
      const devices = await db
        .select({ id: devicesTable.id, name: devicesTable.name, fingerprint: devicesTable.fingerprint })
        .from(devicesTable)
        .where(inArray(devicesTable.id, deviceIds));
      for (const device of devices as any[]) {
        deviceNames.set(device.id, device.name ?? device.fingerprint.slice(0, 8));
      }
    }
    try {
      return NextResponse.json({
        success: true,
        data: rows.map((k: any) => ({
          id: k.id,
          upstreamId: k.upstreamId,
          maskedKey: maskStoredKey(k),
          enabled: k.enabled === 1,
          lastStatus: k.lastStatus,
          deviceId: k.deviceId ?? null,
          deviceName: k.deviceId ? (deviceNames.get(k.deviceId) ?? null) : null,
          createdAt: k.createdAt,
        })),
      });
    } catch (err) {
      if (err instanceof GatewaySecretMissingError) return gatewaySecretError();
      throw err;
    }
  });
});

export const POST = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params; // params 为 Promise（Next 15+ 动态路由）
  const paramsResolved = await params;
  return withSkipCache(async () => {
    await initDatabase();
    const upstreamId = Number(paramsResolved.id);
    const upstream = (
      await db.select().from(upstreamsTable).where(eq(upstreamsTable.id, upstreamId))
    )[0];
    if (!upstream) {
      return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    if (!apiKey) {
      return NextResponse.json({ success: false, error: "Missing required field: apiKey" }, { status: 400 });
    }

    let encrypted: string;
    try {
      encrypted = encryptSecret(apiKey);
    } catch (err) {
      if (err instanceof GatewaySecretMissingError) return gatewaySecretError();
      throw err;
    }

    const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    // per-device key（§12.3 可选开关）：deviceId 非空 = 只给该 relay 下发，直连路径看不到
    const deviceId = parseDeviceId(body.deviceId);
    if (deviceId instanceof Error) {
      return NextResponse.json({ success: false, error: deviceId.message }, { status: 400 });
    }
    if (deviceId !== null && !(await deviceExists(deviceId))) {
      return NextResponse.json({ success: false, error: "Device not found" }, { status: 404 });
    }
    const result = await db
      .insert(upstreamKeysTable)
      .values({
        upstreamId,
        apiKeyEncrypted: encrypted,
        enabled: enabled ? 1 : 0,
        deviceId,
      })
      .returning();

    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "upstream_key_created",
      targetType: "upstream_key",
      targetId: result[0].id,
      ip,
      userAgent,
      details: { upstreamId, deviceId },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          id: result[0].id,
          upstreamId: result[0].upstreamId,
          maskedKey: formatMaskedKey(computeKeyHint(apiKey), result[0].id),
          enabled: result[0].enabled === 1,
          lastStatus: result[0].lastStatus,
          deviceId: result[0].deviceId ?? null,
          createdAt: result[0].createdAt,
        },
      },
      { status: 201 }
    );
  });
});
