import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { loadPlainUpstreamKeys, healthTracker } from "@/lib/gateway/proxy-deps";
import { probeModel } from "@/lib/gateway/probe";
import { parseEnabledModels } from "@/lib/gateway/model-router";

interface Params {
  params: { id: string };
}

// 全部模型可用性测试：遍历 enabled_models 中非通配条目，串行探测
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

    const models = parseEnabledModels(upstream.enabledModels).filter((m) => !m.endsWith("*"));
    if (models.length === 0) {
      return NextResponse.json({
        success: false,
        error: "No concrete models configured for this upstream",
      });
    }

    const keys = await loadPlainUpstreamKeys(upstreamId);
    if (keys.length === 0) {
      return NextResponse.json({
        success: false,
        error: "No enabled API key configured for this upstream",
      });
    }

    const target = { protocol: upstream.protocol as any, baseUrl: upstream.baseUrl };
    const results: { model: string; ok: boolean; status: number; error?: string }[] = [];
    let anyOk = false;
    for (const model of models) {
      const result = await probeModel(target, model, keys[0]);
      results.push({ model, ok: result.ok, status: result.status, error: result.error });
      // 手动测试结果立即更新健康状态：任一成功即恢复 upstream；404/403 标记 model 级
      if (result.ok) {
        anyOk = true;
        await healthTracker.markModelHealthy(upstreamId, model);
      } else if (result.status === 404 || result.status === 403) {
        await healthTracker.markModelUnhealthy(upstreamId, model);
      }
    }
    if (anyOk) {
      await healthTracker.markHealthy(upstreamId);
    }
    return NextResponse.json({ success: true, data: { results } });
  });
});
