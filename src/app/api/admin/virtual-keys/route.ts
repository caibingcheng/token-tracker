import { NextRequest, NextResponse } from "next/server";
import { eq, desc, sql } from "drizzle-orm";
import { db, initDatabase, virtualKeysTable, tokenRecords } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import {
  encryptSecret,
  decryptSecret,
  generateVirtualKey,
  GatewaySecretMissingError,
} from "@/lib/gateway/crypto";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import { hasQuotaLimits } from "@/lib/gateway/quota";
import { loadQuotaUsageBatch } from "@/lib/gateway/quota-db";

function gatewaySecretError() {
  return NextResponse.json(
    { success: false, error: "GATEWAY_SECRET is not configured" },
    { status: 503 }
  );
}

function parseEnabledModelsInput(body: Record<string, unknown>): string | null {
  if (body.enabledModels === undefined) return null;
  if (!Array.isArray(body.enabledModels)) return null;
  const patterns = body.enabledModels.filter(
    (m): m is string => typeof m === "string" && m.trim().length > 0
  );
  if (patterns.length === 0) return null;
  return JSON.stringify(patterns);
}

// 配额字段校验：undefined → 不传；null/0 → NULL（不限制）；非负整数 → 值；其余 → 非法
function parseQuotaField(
  body: Record<string, unknown>,
  field: string
): { ok: true; value?: number | null } | { ok: false } {
  if (body[field] === undefined) return { ok: true };
  const value = body[field];
  if (value === null) return { ok: true, value: null };
  if (typeof value === "number" && Number.isInteger(value) && value >= 0) {
    return { ok: true, value: value === 0 ? null : value };
  }
  return { ok: false };
}

export const GET = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    await initDatabase();
    const rows = await db.select().from(virtualKeysTable).orderBy(desc(virtualKeysTable.id));

    const usageRows = await db
      .select({
        virtualKeyId: tokenRecords.virtualKeyId,
        requestCount: sql<number>`COUNT(*)`,
        totalInput: sql<number>`COALESCE(SUM(${tokenRecords.inputTokens}) + SUM(${tokenRecords.cacheRead}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${tokenRecords.outputTokens}), 0)`,
        totalCacheRead: sql<number>`COALESCE(SUM(${tokenRecords.cacheRead}), 0)`,
        totalCacheWrite: sql<number>`COALESCE(SUM(${tokenRecords.cacheWrite}), 0)`,
      })
      .from(tokenRecords)
      .where(sql`${tokenRecords.virtualKeyId} IS NOT NULL`)
      .groupBy(tokenRecords.virtualKeyId);

    const usageMap = new Map<number, typeof usageRows[number]>();
    for (const row of usageRows) {
      usageMap.set(Number(row.virtualKeyId), row);
    }

    // 窗口配额用量：仅对配置了限额的 vk 批量查询（3 条 GROUP BY，一次完成）
    const quotaVkIds = rows.filter((r: any) => hasQuotaLimits(r)).map((r: any) => r.id);
    const quotaUsageMap =
      quotaVkIds.length > 0 ? await loadQuotaUsageBatch(quotaVkIds, new Date()) : new Map<number, never>();

    const data = rows.map((row: any) => {
      const plain = decryptSecret(row.apiKeyEncrypted);
      const usage = usageMap.get(row.id);
      const q = quotaUsageMap.get(row.id);
      return {
        id: row.id,
        name: row.name,
        apiKey: plain,
        enabled: row.enabled === 1,
        comment: row.comment ?? null,
        enabledModels: row.enabledModels,
        lastUsedAt: row.lastUsedAt,
        maxRpm: row.maxRpm ?? null,
        maxTpm: row.maxTpm ?? null,
        maxDailyTokens: row.maxDailyTokens ?? null,
        maxMonthlyTokens: row.maxMonthlyTokens ?? null,
        createdAt: row.createdAt,
        quotaUsage: q
          ? {
              rpm: q.rpm,
              tpm: q.tpm,
              dailyTokens: q.dailyTokens,
              monthlyTokens: q.monthlyTokens,
            }
          : null,
        usage: usage
          ? {
              requestCount: Number(usage.requestCount),
              totalInput: Number(usage.totalInput),
              totalOutput: Number(usage.totalOutput),
              totalCacheRead: Number(usage.totalCacheRead),
              totalCacheWrite: Number(usage.totalCacheWrite),
            }
          : null,
      };
    });

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
    if (!name) {
      return NextResponse.json({ success: false, error: "Missing required field: name" }, { status: 400 });
    }

    const comment = typeof body.comment === "string" ? body.comment.trim() : "";
    const enabledModels = parseEnabledModelsInput(body);
    if (body.enabledModels !== undefined && !enabledModels) {
      return NextResponse.json(
        { success: false, error: "enabledModels must be a non-empty array of strings" },
        { status: 400 }
      );
    }

    const quotaFields = ["maxRpm", "maxTpm", "maxDailyTokens", "maxMonthlyTokens"] as const;
    const quotaValues: Record<string, number | null> = {};
    for (const field of quotaFields) {
      const parsed = parseQuotaField(body, field);
      if (!parsed.ok) {
        return NextResponse.json(
          { success: false, error: `${field} must be a non-negative integer` },
          { status: 400 }
        );
      }
      if (parsed.value !== undefined) quotaValues[field] = parsed.value;
    }

    const plainKey = generateVirtualKey();
    let encrypted: string;
    try {
      encrypted = encryptSecret(plainKey);
    } catch (err) {
      if (err instanceof GatewaySecretMissingError) return gatewaySecretError();
      throw err;
    }

    try {
      const result = await db
        .insert(virtualKeysTable)
        .values({
          name,
          apiKeyEncrypted: encrypted,
          enabled: 1,
          comment: comment || null,
          enabledModels: enabledModels ?? '["*"]',
          ...quotaValues,
        })
        .returning();
      const { ip, userAgent } = extractClientInfo(request);
      await recordAuditLog({
        action: "virtual_key_created",
        targetType: "virtual_key",
        targetId: result[0].id,
        ip,
        userAgent,
        details: { name: result[0].name },
      });
      return NextResponse.json(
        {
          success: true,
          data: {
            id: result[0].id,
            name: result[0].name,
            apiKey: plainKey,
            enabled: true,
            comment: result[0].comment ?? null,
            enabledModels: result[0].enabledModels,
            lastUsedAt: null,
            maxRpm: result[0].maxRpm ?? null,
            maxTpm: result[0].maxTpm ?? null,
            maxDailyTokens: result[0].maxDailyTokens ?? null,
            maxMonthlyTokens: result[0].maxMonthlyTokens ?? null,
            createdAt: result[0].createdAt,
          },
        },
        { status: 201 }
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        return NextResponse.json({ success: false, error: "Virtual key name already exists" }, { status: 409 });
      }
      console.error("Create virtual key error:", err);
      return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
  });
});
