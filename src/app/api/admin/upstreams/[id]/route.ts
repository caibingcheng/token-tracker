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
import { encryptSecret } from "@/lib/gateway/crypto";
import { decryptProxyUrl } from "@/lib/gateway/proxy-deps";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";

interface Params {
  params: { id: string };
}

async function findUpstream(id: number) {
  const rows = await db.select().from(upstreamsTable).where(eq(upstreamsTable.id, id));
  return rows[0] || null;
}

async function withKeys(upstream: any) {
  const keyRows = await db
    .select()
    .from(upstreamKeysTable)
    .where(eq(upstreamKeysTable.upstreamId, upstream.id));
  const proxyUrl = decryptProxyUrl(upstream.proxyUrlEncrypted);
  const { proxyUrlEncrypted: _proxyUrlEncrypted, ...rest } = upstream;
  return {
    ...rest,
    enabled: upstream.enabled === 1,
    enabledModels: parseEnabledModels(upstream.enabledModels),
    balance: upstream.balance ?? null,
    balanceUpdatedAt: upstream.balanceUpdatedAt ?? null,
    hasProxy: proxyUrl !== null,
    proxyDisplay: proxyUrl ? sanitizeProxyUrlForDisplay(proxyUrl) : null,
    keys: keyRows.map((k: any) => ({
      id: k.id,
      enabled: k.enabled === 1,
      lastStatus: k.lastStatus,
      createdAt: k.createdAt,
    })),
  };
}

export const GET = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const upstream = await findUpstream(id);
    if (!upstream) {
      return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: await withKeys(upstream) });
  });
});

export const PATCH = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const upstream = await findUpstream(id);
    if (!upstream) {
      return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const values: Record<string, unknown> = {};
    if (typeof body.name === "string") {
      const name = body.name.trim();
      if (!name) {
        return NextResponse.json({ success: false, error: "name cannot be empty" }, { status: 400 });
      }
      values.name = name;
    }
    if (typeof body.protocol === "string") {
      if (!isProtocol(body.protocol)) {
        return NextResponse.json({ success: false, error: "Invalid protocol" }, { status: 400 });
      }
      values.protocol = body.protocol;
    }
    if (typeof body.baseUrl === "string") {
      const baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
      try {
        await validateUpstreamBaseUrl(baseUrl);
      } catch (err) {
        if (err instanceof InvalidUpstreamUrlError) {
          return NextResponse.json({ success: false, error: err.message }, { status: 400 });
        }
        throw err;
      }
      values.baseUrl = baseUrl;
    }
    if (Array.isArray(body.enabledModels)) {
      values.enabledModels = JSON.stringify(
        body.enabledModels.filter((m) => typeof m === "string")
      );
    }
    if (body.priority !== undefined && Number.isFinite(Number(body.priority))) {
      values.priority = Number(body.priority);
    }
    if (body.enabled !== undefined) {
      values.enabled = body.enabled ? 1 : 0;
    }
    if (body.healthCheckModel !== undefined) {
      if (body.healthCheckModel === null || body.healthCheckModel === "") {
        values.healthCheckModel = null;
      } else if (typeof body.healthCheckModel === "string") {
        values.healthCheckModel = body.healthCheckModel.trim() || null;
      } else {
        return NextResponse.json(
          { success: false, error: "healthCheckModel must be a string or null" },
          { status: 400 }
        );
      }
    }
    if (body.balance !== undefined) {
      if (body.balance === null || typeof body.balance === "string") {
        values.balance = body.balance;
        values.balanceUpdatedAt = new Date().toISOString();
      } else {
        return NextResponse.json(
          { success: false, error: "balance must be a string or null" },
          { status: 400 }
        );
      }
    }
    if (body.proxyUrl !== undefined) {
      if (body.proxyUrl === null) {
        // 显式 null → 清除代理
        values.proxyUrlEncrypted = null;
      } else if (typeof body.proxyUrl === "string" && body.proxyUrl.trim() !== "") {
        try {
          await validateProxyUrl(body.proxyUrl);
        } catch (err) {
          if (err instanceof InvalidUpstreamUrlError) {
            return NextResponse.json({ success: false, error: err.message }, { status: 400 });
          }
          throw err;
        }
        values.proxyUrlEncrypted = encryptSecret(body.proxyUrl);
      } else if (body.proxyUrl !== "") {
        return NextResponse.json(
          { success: false, error: "proxyUrl must be a string or null" },
          { status: 400 }
        );
      }
      // 空字符串：视为省略（保持现状，不写库）
    }

    if (Object.keys(values).length === 0) {
      return NextResponse.json({ success: false, error: "No fields to update" }, { status: 400 });
    }

    try {
      const result = await db
        .update(upstreamsTable)
        .set(values)
        .where(eq(upstreamsTable.id, id))
        .returning();
      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "upstream_updated",
        targetType: "upstream",
        targetId: id,
        ip,
        userAgent,
        details: { changed: Object.keys(values) },
      });
      // best-effort：enabled_models 变更后对新 model 自动填充官方价
      if (Array.isArray(body.enabledModels)) {
        const { autoFillForModels } = await import("@/lib/model-prices-service");
        autoFillForModels(
          body.enabledModels.filter((m) => typeof m === "string")
        ).catch(() => {});
      }
      return NextResponse.json({ success: true, data: await withKeys(result[0]) });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        return NextResponse.json({ success: false, error: "Upstream name already exists" }, { status: 409 });
      }
      console.error("Update upstream error:", err);
      return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
  });
});

export const DELETE = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const upstream = await findUpstream(id);
    if (!upstream) {
      return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 404 });
    }
    await db.delete(upstreamsTable).where(eq(upstreamsTable.id, id));
    // 可选联动：同时隐藏其历史数据（追加进 hidden_sources，不自动隐藏）
    if (request.nextUrl.searchParams.get("hideHistory") === "1") {
      const { loadHiddenSources, setHiddenSourcesSetting } = await import(
        "@/lib/auth/settings"
      );
      const cfg = await loadHiddenSources();
      if (!cfg.upstreams.includes(upstream.name)) {
        await setHiddenSourcesSetting({
          ...cfg,
          upstreams: [...cfg.upstreams, upstream.name],
        });
      }
    }
    const { ip, userAgent } = extractClientInfo(request);
    await recordAuditLog({
      action: "upstream_deleted",
      targetType: "upstream",
      targetId: id,
      ip,
      userAgent,
      details: { name: upstream.name },
    });
    return NextResponse.json({ success: true });
  });
});
