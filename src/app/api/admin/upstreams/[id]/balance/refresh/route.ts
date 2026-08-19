import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { decryptSecret } from "@/lib/gateway/crypto";
import { fetchBalance, detectBalanceProvider } from "@/lib/gateway/balance";
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

    if (!detectBalanceProvider(upstream.baseUrl)) {
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
      const result = await fetchBalance(
        upstream.baseUrl,
        plainKey,
        decryptProxyUrl(upstream.proxyUrlEncrypted)
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
