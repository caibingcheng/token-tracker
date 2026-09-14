import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamsTable } from "@/lib/db";
import { withAuth } from "@/lib/auth/guard";
import { healthTracker } from "@/lib/gateway/proxy-deps";

interface Params {
  params: { id: string };
}

// 手动触发一次探活（Probe now）：不要求 enabled（与 test-model 手动测试同语义），
// 不记审计（与 test-model 口径一致）；返回最新探活状态供 UI 刷新展示
export const POST = withAuth(async (_request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  await initDatabase();
  const upstreamId = Number(params.id);
  const upstream = (
    await db
      .select({ id: upstreamsTable.id })
      .from(upstreamsTable)
      .where(eq(upstreamsTable.id, upstreamId))
  )[0];
  if (!upstream) {
    return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 404 });
  }
  const probe = await healthTracker.probeNow(upstreamId);
  return NextResponse.json({ success: true, probe });
});
