import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { encryptSecret, GatewaySecretMissingError } from "@/lib/gateway/crypto";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

function maskKey(plain: string): string {
  if (plain.length <= 10) return `${plain.slice(0, 2)}***`;
  return `${plain.slice(0, 6)}***${plain.slice(-4)}`;
}

function gatewaySecretError() {
  return NextResponse.json(
    { success: false, error: "GATEWAY_SECRET is not configured" },
    { status: 503 }
  );
}

interface Params {
  params: { id: string };
}

export const GET = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const upstreamId = Number(params.id);
    const rows = await db
      .select()
      .from(upstreamKeysTable)
      .where(eq(upstreamKeysTable.upstreamId, upstreamId))
      .orderBy(upstreamKeysTable.id);
    return NextResponse.json({
      success: true,
      data: rows.map((k: any) => ({
        id: k.id,
        upstreamId: k.upstreamId,
        maskedKey: maskKey(k.apiKeyEncrypted),
        enabled: k.enabled === 1,
        lastStatus: k.lastStatus,
        createdAt: k.createdAt,
      })),
    });
  });
});

export const POST = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const upstreamId = Number(params.id);
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
          maskedKey: maskKey(encrypted),
          enabled: result[0].enabled === 1,
          lastStatus: result[0].lastStatus,
          createdAt: result[0].createdAt,
        },
      },
      { status: 201 }
    );
  });
});
