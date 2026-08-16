import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { testUpstreamConnection } from "@/lib/gateway/upstream-client";
import { decryptSecret, GatewaySecretMissingError } from "@/lib/gateway/crypto";

function gatewaySecretError() {
  return NextResponse.json(
    { success: false, error: "GATEWAY_SECRET is not configured" },
    { status: 503 }
  );
}

interface Params {
  params: { id: string };
}

// 连接测试：默认用第一个启用 key；可选 body.apiKey 指定临时 key 测试
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

    let body: Record<string, unknown> = {};
    try {
      body = await request.json();
    } catch {
      // ignore, use stored keys
    }

    let apiKey: string | null = typeof body.apiKey === "string" && body.apiKey.trim()
      ? body.apiKey.trim()
      : null;

    if (!apiKey) {
      const keyRows = await db
        .select()
        .from(upstreamKeysTable)
        .where(eq(upstreamKeysTable.upstreamId, upstreamId))
        .orderBy(upstreamKeysTable.id);
      for (const keyRow of keyRows) {
        if (keyRow.enabled !== 1) continue;
        try {
          apiKey = decryptSecret(keyRow.apiKeyEncrypted);
          break;
        } catch {
          continue;
        }
      }
    }

    if (!apiKey) {
      return NextResponse.json({
        success: false,
        error: "No enabled API key configured for this upstream",
      });
    }

    try {
      const result = await testUpstreamConnection(
        { protocol: upstream.protocol as any, baseUrl: upstream.baseUrl },
        apiKey
      );
      return NextResponse.json({
        success: result.ok,
        data: {
          ok: result.ok,
          status: result.status,
          modelCount: result.models?.length ?? 0,
        },
        error: result.error || undefined,
      });
    } catch (err) {
      if (err instanceof GatewaySecretMissingError) return gatewaySecretError();
      console.error("Test upstream error:", err);
      return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
  });
});
