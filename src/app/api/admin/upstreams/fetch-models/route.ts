import { NextRequest, NextResponse } from "next/server";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { fetchUpstreamModels } from "@/lib/gateway/upstream-client";
import { isProtocol } from "@/lib/gateway/model-router";

export const POST = withAuth(async (request: NextRequest) => {
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

    const result = await fetchUpstreamModels({ protocol, baseUrl }, apiKey);
    return NextResponse.json({
      success: !result.error,
      data: { models: result.models, status: result.status, error: result.error },
    });
  });
});
