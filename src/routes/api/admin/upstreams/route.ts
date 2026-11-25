import { NextRequest, NextResponse } from "next/server";
import { desc, eq, count } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { parseEnabledModels } from "@/lib/gateway/model-router";
import { resolveUpstreamAuthConfig } from "@/lib/gateway/auth-style";
import { findAuthModelConflict, parseUpstreamFaceConfig } from "@/lib/admin/upstream-face";
import {
  isBalanceFetchMode,
  balanceAutoFetchOf,
  normalizeBalanceFetchMode,
} from "@/lib/gateway/balance";
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
import type { HeaderTransform } from "@/lib/gateway/header-transforms";
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
import { healthTracker, decryptProxyUrl } from "@/lib/gateway/proxy-deps";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { isReservedRemoteName, REMOTE_NAME_PREFIX } from "@/lib/ingest/validate";

const REMOTE_PREFIX_LABEL = REMOTE_NAME_PREFIX.slice(0, -1);

export const GET = withAuth(async () => {
  return withSkipCache(async () => {
    await initDatabase();
    // enabled 的排前面，组内按 priority（小者先）；disabled 沉到列表末尾
    const rows = await db
      .select()
      .from(upstreamsTable)
      .orderBy(desc(upstreamsTable.enabled), upstreamsTable.priority);
    const keyCounts = await db
      .select({ upstreamId: upstreamKeysTable.upstreamId, count: count() })
      .from(upstreamKeysTable)
      .groupBy(upstreamKeysTable.upstreamId);
    // 参与路由的 key 数（enabled=1）：与 loadPlainUpstreamKeys 的过滤口径一致
    const activeKeyCounts = await db
      .select({ upstreamId: upstreamKeysTable.upstreamId, count: count() })
      .from(upstreamKeysTable)
      .where(eq(upstreamKeysTable.enabled, 1))
      .groupBy(upstreamKeysTable.upstreamId);

    const countMap = new Map<number, number>();
    for (const row of keyCounts) {
      countMap.set(row.upstreamId, row.count);
    }
    const activeCountMap = new Map<number, number>();
    for (const row of activeKeyCounts) {
      activeCountMap.set(row.upstreamId, row.count);
    }

    const data = [];
    for (const row of rows) {
      const proxyUrl = decryptProxyUrl(row.proxyUrlEncrypted);
      const face = resolveUpstreamAuthConfig(row);
      data.push({
        id: row.id,
        name: row.name,
        protocol: face.protocol,
        protocols: face.protocols,
        authStyle: face.authStyle,
        baseUrl: row.baseUrl,
        enabledModels: parseEnabledModels(row.enabledModels),
        priority: row.priority,
        enabled: row.enabled === 1,
        healthCheckModel: row.healthCheckModel ?? null,
        unhealthy: !(await healthTracker.isHealthy(row.id)),
        modelUnhealthy: await healthTracker.listModelUnhealthy(row.id),
        // 探活状态（纯内存，重启后 null = 未探测）
        probe: healthTracker.getProbeStatus(row.id),
        keyCount: countMap.get(row.id) || 0,
        activeKeyCount: activeCountMap.get(row.id) || 0,
        balance: row.balance ?? null,
        balanceUpdatedAt: row.balanceUpdatedAt ?? null,
        balanceFetchMode: row.balanceFetchMode ?? "auto",
        balanceAutoFetch: balanceAutoFetchOf(
          normalizeBalanceFetchMode(row.balanceFetchMode),
          row.baseUrl,
          row.name
        ),
        hasProxy: proxyUrl !== null,
        proxyDisplay: proxyUrl ? sanitizeProxyUrlForDisplay(proxyUrl) : null,
        headerTransforms: parseHeaderTransforms(row.headerTransforms),
        probeConfig: parseProbeConfig(row.probeConfig),
        modelProbeConfigs: parseModelProbeConfigs(row.modelProbeConfigs),
        classifierModels: parseClassifierModels(row.classifierModels),
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
    const baseUrl = typeof body.baseUrl === "string" ? body.baseUrl.trim().replace(/\/+$/, "") : "";

    if (!name || !baseUrl) {
      return NextResponse.json(
        { success: false, error: "Missing required fields: name, baseUrl" },
        { status: 400 }
      );
    }
    const faceConfig = parseUpstreamFaceConfig(body);
    if (!faceConfig.ok) {
      return NextResponse.json({ success: false, error: faceConfig.error }, { status: 400 });
    }
    const { protocol, protocols, authStyle } = faceConfig.value;
    if (isReservedRemoteName(name)) {
      return NextResponse.json(
        { success: false, error: `name cannot start with "${REMOTE_PREFIX_LABEL}"` },
        { status: 400 }
      );
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
    // 同 baseUrl 下 authStyle 不同的记录不允许模型名重叠（否则请求会落到错认证的记录上）
    const existing = await db.select().from(upstreamsTable);
    const conflict = findAuthModelConflict(
      { authStyle, models: enabledModels },
      existing
        .filter((row: any) => row.baseUrl === baseUrl)
        .map((row: any) => ({
          name: row.name,
          baseUrl: row.baseUrl,
          authStyle: resolveUpstreamAuthConfig(row).authStyle,
          models: parseEnabledModels(row.enabledModels),
        })),
      baseUrl
    );
    if (conflict) {
      return NextResponse.json({ success: false, error: conflict }, { status: 400 });
    }
    const priority = Number.isFinite(Number(body.priority)) ? Number(body.priority) : 0;
    const enabled = body.enabled === undefined ? true : Boolean(body.enabled);
    const healthCheckModel =
      typeof body.healthCheckModel === "string" && body.healthCheckModel.trim() !== ""
        ? body.healthCheckModel.trim()
        : null;
    const balanceFetchMode = isBalanceFetchMode(body.balanceFetchMode)
      ? body.balanceFetchMode
      : body.balanceFetchMode === undefined
        ? "auto"
        : null;
    if (balanceFetchMode === null) {
      return NextResponse.json({ success: false, error: "Invalid balanceFetchMode" }, { status: 400 });
    }

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

    // 出站 header 变换：全量替换（省略 = []），仅格式校验（无语义黑名单）
    let headerTransforms: HeaderTransform[] = [];
    if (body.headerTransforms !== undefined) {
      if (!isValidHeaderTransforms(body.headerTransforms)) {
        return NextResponse.json(
          { success: false, error: "Invalid headerTransforms" },
          { status: 400 }
        );
      }
      headerTransforms = body.headerTransforms;
    }

    // 自定义探活端点（省略/null = 默认 chat → responses 双风格）
    let probeConfig: string | null = null;
    if (body.probeConfig !== undefined && body.probeConfig !== null) {
      if (!isValidProbeConfig(body.probeConfig)) {
        return NextResponse.json(
          { success: false, error: "Invalid probeConfig" },
          { status: 400 }
        );
      }
      probeConfig = serializeProbeConfig(body.probeConfig);
    }

    // per-model 探活端点（省略 = 无）：数组，每条 {model, path, body}，model 精确匹配
    let modelProbeConfigs: string | null = null;
    if (body.modelProbeConfigs !== undefined && body.modelProbeConfigs !== null) {
      if (!isValidModelProbeConfigs(body.modelProbeConfigs)) {
        return NextResponse.json(
          { success: false, error: "Invalid modelProbeConfigs" },
          { status: 400 }
        );
      }
      modelProbeConfigs = serializeModelProbeConfigs(body.modelProbeConfigs);
    }

    // 分类器模型声明（省略 = 无）：数组，每条 {model, type, maxInputTokens?, path?}
    let classifierModels: string | null = null;
    if (body.classifierModels !== undefined && body.classifierModels !== null) {
      if (
        !Array.isArray(body.classifierModels) ||
        body.classifierModels.length > MAX_CLASSIFIER_MODELS_PER_UPSTREAM ||
        !body.classifierModels.every(isValidClassifierModelEntry)
      ) {
        return NextResponse.json(
          { success: false, error: "Invalid classifierModels" },
          { status: 400 }
        );
      }
      classifierModels =
        body.classifierModels.length > 0 ? JSON.stringify(body.classifierModels) : null;
    }

    try {
      const result = await db
        .insert(upstreamsTable)
        .values({
          name,
          protocol,
          protocols: JSON.stringify(protocols),
          authStyle,
          baseUrl,
          enabledModels: JSON.stringify(enabledModels),
          priority,
          enabled: enabled ? 1 : 0,
          healthCheckModel,
          balanceFetchMode,
          proxyUrlEncrypted,
          headerTransforms: JSON.stringify(normalizeHeaderTransforms(headerTransforms)),
          probeConfig,
          modelProbeConfigs,
          classifierModels,
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
        details: { name, protocol, protocols, authStyle, hasProxy: proxyUrlEncrypted !== null },
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
