import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { fetchUpstreamModels } from "@/lib/gateway/upstream-client";
import { decryptSecret, GatewaySecretMissingError } from "@/lib/gateway/crypto";
import { parseEnabledModels } from "@/lib/gateway/model-router";

function gatewaySecretError() {
  return NextResponse.json(
    { success: false, error: "GATEWAY_SECRET is not configured" },
    { status: 503 }
  );
}

interface Params {
  params: { id: string };
}

// 拉取上游模型列表，与手动配置的 enabled_models 合并返回
export async function GET(request: NextRequest, { params }: Params) {
  return withSkipCache(async () => {
    await initDatabase();
    const upstreamId = Number(params.id);
    const upstream = (
      await db.select().from(upstreamsTable).where(eq(upstreamsTable.id, upstreamId))
    )[0];
    if (!upstream) {
      return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 404 });
    }

    const keyRows = await db
      .select()
      .from(upstreamKeysTable)
      .where(eq(upstreamKeysTable.upstreamId, upstreamId))
      .orderBy(upstreamKeysTable.id);

    const manual = parseEnabledModels(upstream.enabledModels);

    if (keyRows.length === 0) {
      return NextResponse.json({
        success: true,
        data: {
          upstreamId,
          manual,
          available: [],
          status: null,
          error: "No API keys configured for this upstream",
        },
      });
    }

    let result = null;
    for (const keyRow of keyRows) {
      if (keyRow.enabled !== 1) continue;
      try {
        const plain = decryptSecret(keyRow.apiKeyEncrypted);
        result = await fetchUpstreamModels(
          { protocol: upstream.protocol as any, baseUrl: upstream.baseUrl },
          plain
        );
        if (result.error) continue;
        break;
      } catch {
        continue;
      }
    }

    if (!result || result.error) {
      return NextResponse.json({
        success: true,
        data: {
          upstreamId,
          manual,
          available: [],
          status: result?.status ?? null,
          error: result?.error ?? "Failed to fetch models",
        },
      });
    }

    const merged = Array.from(new Set([...manual, ...result.models]));
    return NextResponse.json({
      success: true,
      data: {
        upstreamId,
        manual,
        available: result.models,
        merged,
        status: result.status,
        error: null,
      },
    });
  });
}
