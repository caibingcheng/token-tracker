import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamsTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { testUpstreamConnection } from "@/lib/gateway/upstream-client";
import { isProtocol } from "@/lib/gateway/model-router";
import {
  validateUpstreamBaseUrl,
  validateProxyUrl,
  InvalidUpstreamUrlError,
} from "@/lib/gateway/url-guard";
import { decryptProxyUrl } from "@/lib/gateway/proxy-deps";

export const POST = withAuth(async (request: NextRequest) => {
  if (!process.env.GATEWAY_SECRET) {
    return NextResponse.json(
      { success: false, error: "GATEWAY_SECRET is not configured" },
      { status: 503 }
    );
  }
  return withSkipCache(async () => {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const protocol = typeof body.protocol === "string" ? body.protocol : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";

    if (!isProtocol(protocol)) {
      return NextResponse.json({ success: false, error: "Invalid protocol" }, { status: 400 });
    }
    let validatedBaseUrl: string;
    try {
      validatedBaseUrl = await validateUpstreamBaseUrl(baseUrl);
    } catch (err) {
      return NextResponse.json(
        { success: false, error: err instanceof InvalidUpstreamUrlError ? err.message : "Invalid baseUrl" },
        { status: 400 }
      );
    }
    if (!apiKey) {
      return NextResponse.json({ success: false, error: "Missing required field: apiKey" }, { status: 400 });
    }

    // 可选代理：显式 proxyUrl 优先；否则提供 upstreamId 时从库存解密补充
    let proxyUrl: string | null = null;
    if (typeof body.proxyUrl === "string" && body.proxyUrl.trim() !== "") {
      try {
        await validateProxyUrl(body.proxyUrl);
      } catch (err) {
        return NextResponse.json(
          { success: false, error: err instanceof InvalidUpstreamUrlError ? err.message : "Invalid proxyUrl" },
          { status: 400 }
        );
      }
      proxyUrl = body.proxyUrl;
    } else if (typeof body.upstreamId === "number" || (typeof body.upstreamId === "string" && body.upstreamId !== "")) {
      await initDatabase();
      const upstreamId = Number(body.upstreamId);
      const row = (await db.select().from(upstreamsTable).where(eq(upstreamsTable.id, upstreamId)))[0];
      if (row) {
        proxyUrl = decryptProxyUrl(row.proxyUrlEncrypted);
      }
    }

    const result = await testUpstreamConnection({ protocol, baseUrl: validatedBaseUrl, proxyUrl }, apiKey);
    return NextResponse.json({
      success: result.ok,
      data: { ok: result.ok, status: result.status, error: result.error },
    });
  });
});
