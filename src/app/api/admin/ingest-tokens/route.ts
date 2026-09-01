import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import {
  listIngestTokens,
  createIngestToken,
} from "@/lib/ingest/tokens";
import { GatewaySecretMissingError } from "@/lib/gateway/crypto";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

function gatewaySecretError() {
  return NextResponse.json(
    { success: false, error: "GATEWAY_SECRET is not configured" },
    { status: 503 }
  );
}

export const GET = withAuth(async () => {
  return withSkipCache(async () => {
    const data = await listIngestTokens();
    return NextResponse.json({ success: true, data });
  });
});

export const POST = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > 64) {
      return NextResponse.json(
        { success: false, error: "name must be a non-empty string (max 64 chars)" },
        { status: 400 }
      );
    }

    let created;
    try {
      created = await createIngestToken(name);
    } catch (err) {
      if (err instanceof GatewaySecretMissingError) return gatewaySecretError();
      throw err;
    }

    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "ingest_token_created",
      targetType: "ingest_token",
      targetId: created.token.id,
      ip,
      userAgent,
      details: { name: created.token.name },
    });

    return NextResponse.json(
      {
        success: true,
        data: {
          ...created.token,
          apiKey: created.plainKey,
        },
      },
      { status: 201 }
    );
  });
});