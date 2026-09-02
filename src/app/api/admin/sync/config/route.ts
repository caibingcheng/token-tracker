import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import {
  loadSyncConfig,
  saveSyncConfig,
  isValidTargetUrl,
} from "@/lib/sync/config";
import { isValidInstanceName } from "@/lib/ingest/validate";
import { GatewaySecretMissingError } from "@/lib/gateway/crypto";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

function gatewaySecretError() {
  return NextResponse.json(
    { success: false, error: "GATEWAY_SECRET is not configured" },
    { status: 503 }
  );
}

// GET：脱敏回显（token 不回显，只回显是否已配置）
export const GET = withAuth(async () => {
  return withSkipCache(async () => {
    const config = await loadSyncConfig();
    return NextResponse.json({
      success: true,
      data: {
        targetUrl: config.targetUrl,
        hasToken: config.hasToken,
        instance: config.instance,
        uid: config.uid,
        epoch: config.epoch,
        boundUid: config.boundUid,
      },
    });
  });
});

// PUT：校验 URL + 可选更新 token（加密落库）
export const PUT = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const input: { targetUrl?: string; token?: string | null; instance?: string } = {};
    if (body.targetUrl !== undefined) {
      if (typeof body.targetUrl !== "string" || !isValidTargetUrl(body.targetUrl)) {
        return NextResponse.json(
          { success: false, error: "targetUrl must be an http(s) URL" },
          { status: 400 }
        );
      }
      input.targetUrl = body.targetUrl.trim().replace(/\/+$/, "");
    }
    if (body.instance !== undefined) {
      const instance = typeof body.instance === "string" ? body.instance.trim() : "";
      if (!isValidInstanceName(instance)) {
        return NextResponse.json(
          { success: false, error: "instance must match [a-z0-9-]{1,32}" },
          { status: 400 }
        );
      }
      // instance 是纯展示名：身份键为 uid，改名随时安全，无锁定校验
      input.instance = instance;
    }
    if (body.token !== undefined) {
      if (body.token === null) {
        input.token = null;
      } else if (typeof body.token === "string") {
        const trimmed = body.token.trim();
        if (trimmed === "" || !trimmed.startsWith("it-")) {
          return NextResponse.json(
            { success: false, error: "token must be non-empty and start with it-" },
            { status: 400 }
          );
        }
        input.token = trimmed;
      } else {
        return NextResponse.json(
          { success: false, error: "token must be a string or null" },
          { status: 400 }
        );
      }
    }
    if (Object.keys(input).length === 0) {
      return NextResponse.json(
        { success: false, error: "No fields to update (targetUrl, token)" },
        { status: 400 }
      );
    }

    try {
      await saveSyncConfig(input);
    } catch (err) {
      if (err instanceof GatewaySecretMissingError) return gatewaySecretError();
      throw err;
    }

    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "sync_config_updated",
      targetType: "sync",
      ip,
      userAgent,
      details: {
        url: input.targetUrl !== undefined ? (input.targetUrl ?? "") : undefined,
        token: input.token !== undefined ? (input.token === null ? "cleared" : "set") : undefined,
        instance: input.instance !== undefined ? input.instance : undefined,
      },
    });

    const config = await loadSyncConfig();
    return NextResponse.json({
      success: true,
      data: {
        targetUrl: config.targetUrl,
        hasToken: config.hasToken,
        instance: config.instance,
        uid: config.uid,
        epoch: config.epoch,
        boundUid: config.boundUid,
      },
    });
  });
});