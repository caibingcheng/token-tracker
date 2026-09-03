import { NextRequest, NextResponse } from "next/server";
import { eq, count } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { isProtocol, parseEnabledModels } from "@/lib/gateway/model-router";
import {
  validateUpstreamBaseUrl,
  validateProxyUrl,
  InvalidUpstreamUrlError,
  sanitizeProxyUrlForDisplay,
} from "@/lib/gateway/url-guard";
import { encryptSecret, GatewaySecretMissingError } from "@/lib/gateway/crypto";
import { healthTracker, decryptProxyUrl } from "@/lib/gateway/proxy-deps";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { isReservedRemoteName, REMOTE_NAME_PREFIX } from "@/lib/ingest/validate";

const REMOTE_PREFIX_LABEL = REMOTE_NAME_PREFIX.slice(0, -1);

function gatewaySecretError() {
  return NextResponse.json(
    { success: false, error: "GATEWAY_SECRET is not configured" },
    { status: 503 }
  );
}

export const GET = withAuth(async () => {
  return withSkipCache(async () => {
    await initDatabase();
    const rows = await db.select().from(upstreamsTable).orderBy(upstreamsTable.priority);
    const keyCounts = await db
      .select({ upstreamId: upstreamKeysTable.upstreamId, count: count() })
      .from(upstreamKeysTable)
      .groupBy(upstreamKeysTable.upstreamId);

    const countMap = new Map<number, number>();
    for (const row of keyCounts) {
      countMap.set(row.upstreamId, row.count);
    }

    const data = [];
    for (const row of rows) {
      const proxyUrl = decryptProxyUrl(row.proxyUrlEncrypted);
      data.push({
        id: row.id,
        name: row.name,
        protocol: row.protocol,
        baseUrl: row.baseUrl,
        enabledModels: parseEnabledModels(row.enabledModels),
        priority: row.priority,
        enabled: row.enabled === 1,
        healthCheckModel: row.healthCheckModel ?? null,
        unhealthy: !(await healthTracker.isHealthy(row.id)),
        modelUnhealthy: await healthTracker.listModelUnhealthy(row.id),
        keyCount: countMap.get(row.id) || 0,
        balance: row.balance ?? null,
        balanceUpdatedAt: row.balanceUpdatedAt ?? null,
        hasProxy: proxyUrl !== null,
        proxyDisplay: proxyUrl ? sanitizeProxyUrlForDisplay(proxyUrl) : null,
        createdAt: row.createdAt,
      });
    }

    return NextResponse.json({ success: true, data });
  });
});

export const POST = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    await initDatabase();
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const name = typeof body.name === "string" ? body.name.trim() : "";
    const protocol = typeof body.protocol === "string" ? body.protocol : "";
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";

    if (!name || !protocol || !baseUrl) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: name, protocol, baseUrl" },
        { status: 400 }
      );
    }
    if (isReservedRemoteName(name)) {
      return NextResponse.json(
        { success: false, error: `name cannot start with "${REMOTE_PREFIX_LABEL}"` },
        { status: 400 }
      );
    }
    if (!isProtocol(protocol)) {
      return NextResponse.json({ success: false, error: "Invalid protocol" }, { status: 400 });
    }
    try {
      await validateUpstreamBaseUrl(baseUrl);
    } catch (err) {
      if (err instanceof InvalidUpstreamUrlError) {
        return NextResponse.json({ success: false, error: err.message }, { status: 400 });
      }
      throw err;
    }

    const enabledModels = Array.isArray(body.enabledModels)
      ? body.enabledModels.filter((m) => typeof m === "string")
      : [];
    const priority = Number.isFinite(Number(body.priority)) ? Number(body.priority) : 0;
    const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    const healthCheckModel =
      typeof body.healthCheckModel === "string" && body.healthCheckModel.trim() !== ""
        ? body.healthCheckModel.trim()
        : null;

    // 可选代理：string（校验后加密落库）或 undefined/空字符串（直连）
    let proxyUrlEncrypted: string | null = null;
    if (typeof body.proxyUrl === "string" && body.proxyUrl.trim() !== "") {
      try {
        await validateProxyUrl(body.proxyUrl);
      } catch (err) {
        if (err instanceof InvalidUpstreamUrlError) {
          return NextResponse.json({ success: false, error: err.message }, { status: 400 });
        }
        throw err;
      }
      proxyUrlEncrypted = encryptSecret(body.proxyUrl);
    }

    try {
      const result = await db
        .insert(upstreamsTable)
        .values({
          name,
          protocol,
          baseUrl,
          enabledModels: JSON.stringify(enabledModels),
          priority,
          enabled: enabled ? 1 : 0,
          healthCheckModel,
          proxyUrlEncrypted,
        })
        .returning();
      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "upstream_created",
        targetType: "upstream",
        targetId: result[0].id,
        ip,
        userAgent,
        // 只记是否存在代理，不回显 proxyUrl（可含凭据）
        details: { name, protocol, hasProxy: proxyUrlEncrypted !== null },
      });
      // best-effort：对新增 model 自动填充官方价（失败静默，不阻塞保存）
      const { autoFillForModels } = await import("@/lib/model-prices-service");
      autoFillForModels(enabledModels).catch(() => {});
      return NextResponse.json({ success: true, data: result[0] }, { status: 201 });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        return NextResponse.json({ success: false, error: "Upstream name already exists" }, { status: 409 });
      }
      console.error("Create upstream error:", err);
      return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
  });
});
