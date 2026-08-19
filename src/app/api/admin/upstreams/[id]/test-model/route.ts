import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { loadPlainUpstreamKeys, healthTracker, decryptProxyUrl } from "@/lib/gateway/proxy-deps";
import { probeModelWithKeys } from "@/lib/gateway/probe";

interface Params {
  params: { id: string };
}

// 单模型可用性测试：POST body { model: string }，依次用每个启用 key 探测，任一成功即可用
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
      // ignore
    }

    const model = typeof body.model === "string" ? body.model.trim() : "";
    if (!model) {
      return NextResponse.json({ success: false, error: "model is required" }, { status: 400 });
    }

    const keys = await loadPlainUpstreamKeys(upstreamId);
    if (keys.length === 0) {
      return NextResponse.json({
        success: false,
        error: "No enabled API key configured for this upstream",
      });
    }

    const result = await probeModelWithKeys(
      {
        protocol: upstream.protocol as any,
        baseUrl: upstream.baseUrl,
        proxyUrl: decryptProxyUrl(upstream.proxyUrlEncrypted),
      },
      model,
      keys
    );

    // 手动测试结果立即更新健康状态，不依赖 30 分钟自动探活
    if (result.ok) {
      await healthTracker.markHealthy(upstreamId);
      await healthTracker.markModelHealthy(upstreamId, model);
    } else if (result.sawModelError) {
      await healthTracker.markModelUnhealthy(upstreamId, model);
    } else if (result.sawAuthError) {
      await healthTracker.markUnhealthy(upstreamId);
    }

    return NextResponse.json({
      success: true,
      data: {
        model,
        ok: result.ok,
        status: result.status,
        error: result.error,
        keysTested: result.keyResults.length,
      },
    });
  });
});
