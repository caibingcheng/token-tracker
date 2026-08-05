import { NextRequest, NextResponse } from "next/server";
import { eq, desc, sql } from "drizzle-orm";
import { db, initDatabase, virtualKeysTable, tokenRecords } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";

interface Params {
  params: { id: string };
}

// 单个虚拟 key 的用量统计（按 agent 名聚合 token_records）
export async function GET(request: NextRequest, { params }: Params) {
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const row = (
      await db.select().from(virtualKeysTable).where(eq(virtualKeysTable.id, id))
    )[0];
    if (!row) {
      return NextResponse.json({ success: false, error: "Virtual key not found" }, { status: 404 });
    }

    const usage = await db
      .select({
        requestCount: sql<number>`COUNT(*)`,
        totalInput: sql<number>`COALESCE(SUM(${tokenRecords.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${tokenRecords.outputTokens}), 0)`,
        totalCacheRead: sql<number>`COALESCE(SUM(${tokenRecords.cacheRead}), 0)`,
        totalCacheWrite: sql<number>`COALESCE(SUM(${tokenRecords.cacheWrite}), 0)`,
        lastActiveAt: sql<string | null>`MAX(${tokenRecords.createdAt})`,
      })
      .from(tokenRecords)
      .where(eq(tokenRecords.agent, row.name));

    const recent = await db
      .select({
        id: tokenRecords.id,
        model: tokenRecords.model,
        provider: tokenRecords.provider,
        inputTokens: tokenRecords.inputTokens,
        outputTokens: tokenRecords.outputTokens,
        cacheRead: tokenRecords.cacheRead,
        cacheWrite: tokenRecords.cacheWrite,
        status: tokenRecords.status,
        createdAt: tokenRecords.createdAt,
      })
      .from(tokenRecords)
      .where(eq(tokenRecords.agent, row.name))
      .orderBy(desc(tokenRecords.createdAt))
      .limit(20);

    return NextResponse.json({
      success: true,
      data: {
        id: row.id,
        name: row.name,
        enabled: row.enabled === 1,
        lastUsedAt: row.lastUsedAt,
        usage: usage[0],
        recent,
      },
    });
  });
}
