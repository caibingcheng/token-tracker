import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { decryptSecret } from "@/lib/gateway/crypto";
import { fetchBalance, resolveBalanceMode, normalizeBalanceFetchMode } from "@/lib/gateway/balance";
import { decryptProxyUrl } from "@/lib/gateway/proxy-deps";

interface Params {
  params: { id: string };
}

export const POST = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const upstream = (
      await db.select().from(upstreamsTable).where(eq(upstreamsTable.id, id))
    )[0];
    if (!upstream) {
      return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 404 });
    }

    const mode = normalizeBalanceFetchMode(upstream.balanceFetchMode);
    // auto 同样用 name 回退探测，与 balanceAutoFetchOf / 表单跟随口径一致
    const provider = resolveBalanceMode(upstream.baseUrl, mode, upstream.name);
    if (mode === "none") {
      return NextResponse.json(
        { success: false, error: "Balance auto-fetch is disabled for this upstream" },
        { status: 400 }
      );
    }
    if (!provider) {
      return NextResponse.json(
        { success: false, error: "Balance auto-fetch is not supported for this upstream" },
        { status: 400 }
      );
    }

    const keyRows = await db
      .select()
      .from(upstreamKeysTable)
      .where(eq(upstreamKeysTable.upstreamId, id))
      .orderBy(upstreamKeysTable.id);

    let plainKey: string | null = null;
    for (const row of keyRows) {
      if (row.enabled !== 1) continue;
      try {
        plainKey = decryptSecret(row.apiKeyEncrypted);
        break;
      } catch {
        continue;
      }
    }
    if (!plainKey) {
      return NextResponse.json(
        { success: false, error: "No enabled API key available for this upstream" },
        { status: 400 }
      );
    }

    try {
      // 传入解析后的 provider，避免 fetchBalance 内部再探测一次（缺 name 会不一致）
      const result = await fetchBalance(
        upstream.baseUrl,
        plainKey,
        decryptProxyUrl(upstream.proxyUrlEncrypted),
        provider
      );
      await db
        .update(upstreamsTable)
        .set({
          balance: result.balance,
          balanceUpdatedAt: new Date().toISOString(),
        })
        .where(eq(upstreamsTable.id, id));
      return NextResponse.json({
        success: true,
        data: {
          balance: result.balance,
          currency: result.currency,
          balanceUpdatedAt: new Date().toISOString(),
        },
      });
    } catch (err) {
      return NextResponse.json(
        { success: false, error: err instanceof Error ? err.message : String(err) },
        { status: 502 }
      );
    }
  });
});
