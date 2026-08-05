import { NextRequest, NextResponse } from "next/server";
import { withSkipCache } from "@/lib/db/cache";
import { testUpstreamConnection } from "@/lib/gateway/upstream-client";
import { isProtocol } from "@/lib/gateway/model-router";

export async function POST(request: NextRequest) {
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
    if (!/^https?:\/\//.test(baseUrl)) {
      return NextResponse.json({ success: false, error: "baseUrl must start with http(s)://" }, { status: 400 });
    }
    if (!apiKey) {
      return NextResponse.json({ success: false, error: "Missing required field: apiKey" }, { status: 400 });
    }

    const result = await testUpstreamConnection({ protocol, baseUrl }, apiKey);
    return NextResponse.json({
      success: result.ok,
      data: { ok: result.ok, status: result.status, error: result.error },
    });
  });
}
