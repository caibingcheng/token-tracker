import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable, upstreamModelHealthTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { parseEnabledModels } from "@/lib/gateway/model-router";
import { resolveUpstreamAuthConfig } from "@/lib/gateway/auth-style";
import { findAuthModelConflict, parseUpstreamFaceConfig } from "@/lib/admin/upstream-face";
import { isBalanceFetchMode, balanceAutoFetchOf, normalizeBalanceFetchMode } from "@/lib/gateway/balance";
import {
  validateUpstreamBaseUrl,
  validateProxyUrl,
  InvalidUpstreamUrlError,
  sanitizeProxyUrlForDisplay,
} from "@/lib/gateway/url-guard";
import { encryptSecret } from "@/lib/gateway/crypto";
import {
  isValidHeaderTransforms,
  normalizeHeaderTransforms,
  parseHeaderTransforms,
} from "@/lib/gateway/header-transforms";
import {
  isValidModelProbeConfigs,
  isValidProbeConfig,
  parseModelProbeConfigs,
  parseProbeConfig,
  serializeModelProbeConfigs,
  serializeProbeConfig,
} from "@/lib/gateway/probe-config";
import {
  isValidClassifierModelEntry,
  parseClassifierModels,
  MAX_CLASSIFIER_MODELS_PER_UPSTREAM,
} from "@/lib/gateway/classifier/types";
import { decryptProxyUrl, healthTracker } from "@/lib/gateway/proxy-deps";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { isReservedRemoteName, REMOTE_NAME_PREFIX } from "@/lib/ingest/validate";

interface Params {
  params: Promise<{ id: string }>;
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
  const {
    proxyUrlEncrypted: _proxyUrlEncrypted,
    headerTransforms: _raw,
    probeConfig: _probe,
    modelProbeConfigs: _mpc,
    ...rest
  } = upstream;
  return {
    ...rest,
    enabled: upstream.enabled === 1,
    // 认证/面配置：归一化后返回（protocols / authStyle 缺省值时也能直接用于 UI）
    ...resolveUpstreamAuthConfig(upstream as any),
    enabledModels: parseEnabledModels(upstream.enabledModels),
    balance: upstream.balance ?? null,
    balanceUpdatedAt: upstream.balanceUpdatedAt ?? null,
    balanceFetchMode: upstream.balanceFetchMode,
    balanceAutoFetch: balanceAutoFetchOf(
      normalizeBalanceFetchMode(upstream.balanceFetchMode),
      upstream.baseUrl,
      upstream.name
    ),
    hasProxy: proxyUrl !== null,
    proxyDisplay: proxyUrl ? sanitizeProxyUrlForDisplay(proxyUrl) : null,
    headerTransforms: parseHeaderTransforms(upstream.headerTransforms),
    probeConfig: parseProbeConfig(upstream.probeConfig),
    modelProbeConfigs: parseModelProbeConfigs(upstream.modelProbeConfigs),
    classifierModels: parseClassifierModels(upstream.classifierModels),
    keys: keyRows.map((k: any) => ({
      id: k.id,
      enabled: k.enabled === 1,
      lastStatus: k.lastStatus,
      createdAt: k.createdAt,
    })),
  };
}

export const GET = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params; // params 为 Promise（Next 15+ 动态路由）
  const paramsResolved = await params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(paramsResolved.id);
    const upstream = await findUpstream(id);
    if (!upstream) {
      return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: await withKeys(upstream) });
  });
});

export const PATCH = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params; // params 为 Promise（Next 15+ 动态路由）
  const paramsResolved = await params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(paramsResolved.id);
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
      if (isReservedRemoteName(name)) {
        return NextResponse.json(
          { success: false, error: "name cannot start with \"" + REMOTE_NAME_PREFIX + "\"" },
          { status: 400 }
        );
      }
      values.name = name;
    }
    // 接受面集合 / 默认面 / 认证方式：任一显式提供时整体重算（省略 = 保留存量）
    if (
      body.protocol !== undefined ||
      body.protocols !== undefined ||
      body.authStyle !== undefined
    ) {
      const current = resolveUpstreamAuthConfig(upstream as any);
      const parsed = parseUpstreamFaceConfig({
        protocols: body.protocols !== undefined ? body.protocols : current.protocols,
        // 只在显式给 protocol 时才要求它在集合内；否则跟随 protocols[0]
        // （UI 只提交 protocols，重排即可换默认面/探活面）
        protocol:
          body.protocol !== undefined
            ? body.protocol
            : body.protocols !== undefined
              ? undefined
              : current.protocol,
        authStyle: body.authStyle !== undefined ? body.authStyle : current.authStyle,
      });
      if (!parsed.ok) {
        return NextResponse.json({ success: false, error: parsed.error }, { status: 400 });
      }
      values.protocols = JSON.stringify(parsed.value.protocols);
      values.authStyle = parsed.value.authStyle;
      values.protocol = parsed.value.protocol;
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

    // 同 baseUrl 下 authStyle 不同的记录不允许模型名重叠（校验取值后的最终状态）。
    // 只在本次改动可能影响该不变量时校验：存量库可能本就违例（旧版允许跨协议同模型），
    // 无差别校验会让“只改 priority/name”的编辑被 400 卡死。
    const touchesFaces =
      body.protocol !== undefined ||
      body.protocols !== undefined ||
      body.authStyle !== undefined ||
      Array.isArray(body.enabledModels) ||
      typeof body.baseUrl === "string";
    if (touchesFaces) {
      const current = resolveUpstreamAuthConfig(upstream as any);
      const nextAuthStyle = (values.authStyle as any) ?? current.authStyle;
      const nextBaseUrl = (values.baseUrl as string) ?? upstream.baseUrl;
      const nextModels = values.enabledModels
        ? (JSON.parse(values.enabledModels as string) as string[])
        : parseEnabledModels(upstream.enabledModels);
      const rows = await db.select().from(upstreamsTable);
      const conflict = findAuthModelConflict(
        { authStyle: nextAuthStyle, models: nextModels },
        rows
          .filter((row: any) => row.id !== id && row.baseUrl === nextBaseUrl)
          .map((row: any) => ({
            name: row.name,
            baseUrl: row.baseUrl,
            authStyle: resolveUpstreamAuthConfig(row).authStyle,
            models: parseEnabledModels(row.enabledModels),
          })),
        nextBaseUrl
      );
      if (conflict) {
        return NextResponse.json({ success: false, error: conflict }, { status: 400 });
      }
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
    if (body.balanceFetchMode !== undefined) {
      if (isBalanceFetchMode(body.balanceFetchMode)) {
        values.balanceFetchMode = body.balanceFetchMode;
      } else {
        return NextResponse.json(
          { success: false, error: "Invalid balanceFetchMode" },
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
    // 出站 header 变换：全量替换（随 upstream 保存整体提交）
    if (body.headerTransforms !== undefined) {
      if (!isValidHeaderTransforms(body.headerTransforms)) {
        return NextResponse.json(
          { success: false, error: "Invalid headerTransforms" },
          { status: 400 }
        );
      }
      values.headerTransforms = JSON.stringify(
        normalizeHeaderTransforms(body.headerTransforms)
      );
    }
    // 自定义探活端点：对象 = 设置，null = 清除（回落默认双风格）
    if (body.probeConfig !== undefined) {
      if (body.probeConfig === null) {
        values.probeConfig = null;
      } else if (isValidProbeConfig(body.probeConfig)) {
        values.probeConfig = serializeProbeConfig(body.probeConfig);
      } else {
        return NextResponse.json(
          { success: false, error: "Invalid probeConfig" },
          { status: 400 }
        );
      }
    }

    // per-model 探活端点：数组 = 全量替换，null = 清除
    if (body.modelProbeConfigs !== undefined) {
      if (body.modelProbeConfigs === null) {
        values.modelProbeConfigs = null;
      } else if (isValidModelProbeConfigs(body.modelProbeConfigs)) {
        values.modelProbeConfigs = serializeModelProbeConfigs(body.modelProbeConfigs);
      } else {
        return NextResponse.json(
          { success: false, error: "Invalid modelProbeConfigs" },
          { status: 400 }
        );
      }
    }

    // 分类器模型声明：数组 = 全量替换，null = 清除
    if (body.classifierModels !== undefined) {
      if (body.classifierModels === null) {
        values.classifierModels = null;
      } else if (
        Array.isArray(body.classifierModels) &&
        body.classifierModels.length <= MAX_CLASSIFIER_MODELS_PER_UPSTREAM &&
        body.classifierModels.every(isValidClassifierModelEntry)
      ) {
        values.classifierModels =
          body.classifierModels.length > 0 ? JSON.stringify(body.classifierModels) : null;
      } else {
        return NextResponse.json(
          { success: false, error: "Invalid classifierModels" },
          { status: 400 }
        );
      }
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
      // 探活生命周期联动：禁用停 timer 保留 DB 状态；重新启用且仍 unhealthy → 立即探活
      // （fire-and-forget，不阻塞 PATCH 响应，最长 N key × 15s 在后台完成）
      if (body.enabled === false) {
        healthTracker.stopProbing(id);
      } else if (body.enabled === true) {
        healthTracker.resumeProbing(id);
        if (!(await healthTracker.isHealthy(id))) {
          void healthTracker.probeNow(id).catch(() => {});
        }
      }
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
  const { params } = ctx as Params; // params 为 Promise（Next 15+ 动态路由）
  const paramsResolved = await params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(paramsResolved.id);
    const upstream = await findUpstream(id);
    if (!upstream) {
      return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 404 });
    }
    await db.delete(upstreamsTable).where(eq(upstreamsTable.id, id));
    // 探活清理：停 timer + 清内存态（含 model 标记），并清除 upstream_model_health 残留行
    healthTracker.removeUpstream(id);
    await db.delete(upstreamModelHealthTable).where(eq(upstreamModelHealthTable.upstreamId, id));
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
