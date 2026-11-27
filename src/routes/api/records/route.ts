import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords, devicesTable } from "@/lib/db";
import { sql, desc, eq, and, gte, lte, inArray, SQL } from "drizzle-orm";
import { resolveProviderFilters, loadHiddenProviderGroups, anonymizeProvider } from "@/lib/provider-utils";
import { normalizeModel, resolveNormalizedModelFilters } from "@/lib/model-utils";
import { getDisplayName } from "@/lib/model-registry";
import { loadModelAliases, loadAgentAliases } from "@/lib/auth/settings";
import { resolveAgentName, resolveAgentUserAgentsMulti } from "@/lib/agent-utils";
import { buildAgentUaWhereClause } from "@/lib/stats-query";
import { parseFilterValues, FilterParamError } from "@/lib/filter-params";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    await initDatabase();
    try {
      const groups = await loadHiddenProviderGroups();
      const aliases = await loadModelAliases();
      const agentAliases = await loadAgentAliases();
      const { searchParams } = new URL(request.url);

      // 分页参数
      const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
      const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
      const offset = (page - 1) * limit;

      // 筛选条件（多选：重复参数；空值/"all" 等于不筛选；单值链接行为不变）
      const modelParams = parseFilterValues(searchParams, "model");
      const providerParams = parseFilterValues(searchParams, "provider");
      const agentParams = parseFilterValues(searchParams, "agent");

      let providerFilter: string[] | null = null;
      if (providerParams.length > 0) {
        const allProviderRows = await db
          .selectDistinct({ provider: tokenRecords.provider })
          .from(tokenRecords);
        const allProviderNames: string[] = allProviderRows
          .map((r: any) => r.provider)
          .filter((n: any): n is string => n !== null && n !== undefined);

        const resolved = resolveProviderFilters(
          providerParams,
          allProviderNames,
          groups
        );
        if (resolved.unknown.length > 0) {
          return NextResponse.json(
            {
              success: false,
              error: `Unknown provider: ${resolved.unknown.join(", ")}`,
            },
            { status: 400 }
          );
        }
        providerFilter = resolved.filter;
      }

      let modelFilter: string[] | null = null;
      if (modelParams.length > 0) {
        const allModelRows = await db
          .selectDistinct({ model: tokenRecords.model, provider: tokenRecords.provider })
          .from(tokenRecords);
        const allRawModels: string[] = allModelRows
          .map((r: any) => r.model)
          .filter((n: any): n is string => n !== null && n !== undefined);
        const providerByModel = new Map<string, string>();
        for (const row of allModelRows) {
          if (row.model && row.provider) {
            providerByModel.set(row.model, row.provider);
          }
        }

        const resolved = resolveNormalizedModelFilters(
          modelParams,
          allRawModels,
          providerByModel,
          groups,
          aliases
        );
        if (resolved.unknown.length > 0) {
          return NextResponse.json(
            {
              success: false,
              error: `Unknown model: ${resolved.unknown.join(", ")}`,
            },
            { status: 400 }
          );
        }
        modelFilter = resolved.filter;
      }

      const conditions: SQL[] = [];

      if (agentParams.length > 0) {
        const uaRows = await db
          .selectDistinct({ ua: tokenRecords.userAgent })
          .from(tokenRecords);
        const allUas: Array<string | null> = uaRows.map((r: any) => r.ua);
        const resolved = resolveAgentUserAgentsMulti(
          agentParams,
          allUas,
          agentAliases
        );
        if (resolved.unknownNames.length > 0) {
          return NextResponse.json(
            {
              success: false,
              error: `Unknown agent: ${resolved.unknownNames.join(", ")}`,
            },
            { status: 400 }
          );
        }
        const agentCondition = buildAgentUaWhereClause(resolved.filter);
        if (agentCondition) conditions.push(agentCondition);
      }

      if (modelFilter) {
        if (modelFilter.length === 1) {
          conditions.push(eq(tokenRecords.model, modelFilter[0]));
        } else {
          conditions.push(inArray(tokenRecords.model, modelFilter));
        }
      }
      if (providerFilter) {
        if (providerFilter.length === 1) {
          conditions.push(eq(tokenRecords.provider, providerFilter[0]));
        } else {
          conditions.push(inArray(tokenRecords.provider, providerFilter));
        }
      }

      const startDate = searchParams.get("startDate");
      if (startDate) conditions.push(gte(tokenRecords.createdAt, new Date(startDate)));

      const endDate = searchParams.get("endDate");
      if (endDate) {
        const end = new Date(endDate);
        const nextDay = new Date(end);
        nextDay.setDate(nextDay.getDate() + 1);
        conditions.push(lte(tokenRecords.createdAt, nextDay));
      }

      const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

      const query = db
        .select({
          id: tokenRecords.id,
          model: tokenRecords.model,
          provider: tokenRecords.provider,
          agent: tokenRecords.agent,
          userAgent: tokenRecords.userAgent,
          inputTokens: tokenRecords.inputTokens,
          outputTokens: tokenRecords.outputTokens,
          cacheRead: tokenRecords.cacheRead,
          cacheWrite: tokenRecords.cacheWrite,
          latencyMs: tokenRecords.latencyMs,
          ttftMs: tokenRecords.ttftMs,
          status: tokenRecords.status,
          requestModel: tokenRecords.requestModel,
          sessionId: tokenRecords.sessionId,
          deviceId: tokenRecords.deviceId,
          createdAt: tokenRecords.createdAt,
        })
        .from(tokenRecords)
        .orderBy(desc(tokenRecords.createdAt))
        .limit(limit)
        .offset(offset);
      const rawData = whereClause ? await query.where(whereClause) : await query;
      // relay 设备展示名：device 被删后 token_records.device_id 置 NULL（历史保留）
      const deviceIds = [
        ...new Set(rawData.map((r: any) => r.deviceId).filter((id: any): id is number => typeof id === "number")),
      ];
      const deviceNames = new Map<number, string>();
      if (deviceIds.length > 0) {
        const rows = await db
          .select({ id: devicesTable.id, name: devicesTable.name, fingerprint: devicesTable.fingerprint })
          .from(devicesTable)
          .where(inArray(devicesTable.id, deviceIds));
        for (const row of rows as any[]) {
          deviceNames.set(row.id, row.name ?? row.fingerprint.slice(0, 8));
        }
      }
      const data = rawData.map((record: any) => ({
        id: record.id,
        model: record.model,
        agent: resolveAgentName(record.userAgent, agentAliases),
        userAgent: record.userAgent,
        keyName: record.agent,
        inputTokens: record.inputTokens,
        outputTokens: record.outputTokens,
        cacheRead: record.cacheRead,
        cacheWrite: record.cacheWrite,
        latencyMs: record.latencyMs,
        ttftMs: record.ttftMs,
        status: record.status,
        requestModel: record.requestModel,
        sessionId: record.sessionId,
        deviceId: record.deviceId ?? null,
        deviceName: record.deviceId ? (deviceNames.get(record.deviceId) ?? null) : null,
        createdAt: record.createdAt,
        providerName: record.provider
          ? anonymizeProvider(record.provider, [], groups)
          : null,
        normalizedModel: getDisplayName(normalizeModel(record.model, record.provider ?? undefined, groups, aliases), aliases),
      }));

      const countQuery = db
        .select({ count: sql<number>`COUNT(*)` })
        .from(tokenRecords);
      const countResult = whereClause
        ? await countQuery.where(whereClause)
        : await countQuery;

      const total = countResult[0].count;

      return NextResponse.json({
        success: true,
        data,
        pagination: {
          page,
          limit,
          total,
          totalPages: Math.ceil(total / limit),
        },
      });
    } catch (error) {
      if (error instanceof FilterParamError) {
        return NextResponse.json(
          { success: false, error: error.message },
          { status: 400 }
        );
      }
      console.error("Records error:", error);
      return NextResponse.json(
        { success: false, error: "Internal server error" },
        { status: 500 }
      );
    }
  });
});
