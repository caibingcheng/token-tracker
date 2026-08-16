import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { fetchUpstreamModels } from "@/lib/gateway/upstream-client";
import { decryptSecret } from "@/lib/gateway/crypto";
import { isProtocol } from "@/lib/gateway/model-router";
import { validateUpstreamBaseUrl, InvalidUpstreamUrlError } from "@/lib/gateway/url-guard";

export const POST = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    await initDatabase();

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const protocol = typeof body.protocol === "string" ? body.protocol : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";
    const apiKey = typeof body.apiKey === "string" ? body.apiKey.trim() : "";
    const upstreamId =
      typeof body.upstreamId === "number"
        ? body.upstreamId
        : typeof body.upstreamId === "string" && body.upstreamId !== ""
          ? Number(body.upstreamId)
          : undefined;

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

    // 表单有明文 key 时优先使用
    if (apiKey) {
      const result = await fetchUpstreamModels({ protocol, baseUrl: validatedBaseUrl }, apiKey);
      return NextResponse.json({
        success: !result.error,
        data: { models: result.models, status: result.status, error: result.error },
      });
    }

    // 编辑模式下表单无 key：用 upstreamId 取已存储的 key
    if (upstreamId === undefined || !Number.isInteger(upstreamId)) {
      return NextResponse.json(
        { success: false, error: "Missing required field: apiKey or upstreamId" },
        { status: 400 }
      );
    }
    const keyRows = (
      await db.select().from(upstreamKeysTable).where(eq(upstreamKeysTable.upstreamId, upstreamId))
    ).filter((row: any) => row.enabled === 1);
    if (keyRows.length === 0) {
      return NextResponse.json(
        { success: false, error: "No enabled API key configured for this upstream" },
        { status: 400 }
      );
    }

    let result = null;
    for (const keyRow of keyRows) {
      try {
        const plain = decryptSecret(keyRow.apiKeyEncrypted);
        result = await fetchUpstreamModels({ protocol, baseUrl: validatedBaseUrl }, plain);
        if (result.error) continue;
        break;
      } catch {
        continue;
      }
    }

    if (!result || result.error) {
      return NextResponse.json(
        { success: false, error: result?.error ?? "Failed to fetch models" },
        { status: 502 }
      );
    }
    return NextResponse.json({
      success: true,
      data: { models: result.models, status: result.status, error: null },
    });
  });
});
