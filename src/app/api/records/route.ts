import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { sql, desc, eq, and, gte, lte, inArray, SQL } from "drizzle-orm";
import { resolveProviderFilter, loadHiddenProviderGroups } from "@/lib/provider-utils";
import { normalizeModel, resolveNormalizedModelFilter } from "@/lib/model-utils";
import { getDisplayName } from "@/lib/model-registry";
import { loadModelAliases } from "@/lib/auth/settings";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    await initDatabase();
    try {
      const groups = await loadHiddenProviderGroups();
      const aliases = await loadModelAliases();
      const { searchParams } = new URL(request.url);

      // 分页参数
      const page = Math.max(1, parseInt(searchParams.get("page") || "1", 10));
      const limit = Math.min(200, Math.max(1, parseInt(searchParams.get("limit") || "50", 10)));
      const offset = (page - 1) * limit;

      // 筛选条件（过滤参数限长，防缓存 key 膨胀）
      const modelParam = searchParams.get("model");
      const provider = searchParams.get("provider");
      const agent = searchParams.get("agent");
      for (const [name, value] of [
        ["model", modelParam],
        ["provider", provider],
        ["agent", agent],
      ] as const) {
        if (value !== null && value.length > 128) {
          return NextResponse.json(
            { success: false, error: `Parameter "${name}" is too long` },
            { status: 400 }
          );
        }
      }
      let providerFilter: string[] | null = null;
      if (provider) {
        const allProviderRows = await db
          .selectDistinct({ provider: tokenRecords.provider })
          .from(tokenRecords);
        const allProviderNames: string[] = allProviderRows
          .map((r: any) => r.provider)
          .filter((n: any): n is string => n !== null && n !== undefined);

        providerFilter = resolveProviderFilter(provider, allProviderNames, groups);

        if (!providerFilter || providerFilter.length === 0) {
          return NextResponse.json(
            { success: false, error: `Unknown provider: ${provider}` },
            { status: 400 }
          );
        }
      }

      let modelFilter: string[] | null = null;
      if (modelParam) {
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

        modelFilter = resolveNormalizedModelFilter(modelParam, allRawModels, providerByModel, groups, aliases);

        if (!modelFilter || modelFilter.length === 0) {
          return NextResponse.json(
            { success: false, error: `Unknown model: ${modelParam}` },
            { status: 400 }
          );
        }
      }

      const conditions: SQL[] = [];

      if (agent) {
        conditions.push(eq(tokenRecords.agent, agent));
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
          inputTokens: tokenRecords.inputTokens,
          outputTokens: tokenRecords.outputTokens,
          cacheRead: tokenRecords.cacheRead,
          cacheWrite: tokenRecords.cacheWrite,
          requestModel: tokenRecords.requestModel,
          createdAt: tokenRecords.createdAt,
        })
        .from(tokenRecords)
        .orderBy(desc(tokenRecords.createdAt))
        .limit(limit)
        .offset(offset);
      const rawData = whereClause ? await query.where(whereClause) : await query;
      const data = rawData.map((record: any) => ({
        ...record,
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
      console.error("Records error:", error);
      return NextResponse.json(
        { success: false, error: "Internal server error" },
        { status: 500 }
      );
    }
  });
});
