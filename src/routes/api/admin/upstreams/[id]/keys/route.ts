import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable } from "@/lib/db";
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
    // per-device key 功能已移除：所有 key 都是通用 key（直连/relay 共用）
    try {
      return NextResponse.json({
        success: true,
        data: rows.map((k: any) => ({
          id: k.id,
          upstreamId: k.upstreamId,
          maskedKey: maskStoredKey(k),
          enabled: k.enabled === 1,
          lastStatus: k.lastStatus,
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
    const result = await db
      .insert(upstreamKeysTable)
      .values({
        upstreamId,
        apiKeyEncrypted: encrypted,
        enabled: enabled ? 1 : 0,
      })
      .returning();

    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "upstream_key_created",
      targetType: "upstream_key",
      targetId: result[0].id,
      ip,
      userAgent,
      details: { upstreamId },
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
          createdAt: result[0].createdAt,
        },
      },
      { status: 201 }
    );
  });
});
