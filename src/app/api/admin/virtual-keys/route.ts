import { NextRequest, NextResponse } from "next/server";
import { eq, desc, sql } from "drizzle-orm";
import { db, initDatabase, virtualKeysTable, tokenRecords } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import {
  encryptSecret,
  decryptSecret,
  generateVirtualKey,
  GatewaySecretMissingError,
} from "@/lib/gateway/crypto";

function gatewaySecretError() {
  return NextResponse.json(
    { success: false, error: "GATEWAY_SECRET is not configured" },
    { status: 503 }
  );
}

export async function GET(request: NextRequest) {
  return withSkipCache(async () => {
    await initDatabase();
    const rows = await db.select().from(virtualKeysTable).orderBy(desc(virtualKeysTable.id));

    const usageRows = await db
      .select({
        agent: tokenRecords.agent,
        requestCount: sql<number>`COUNT(*)`,
        totalInput: sql<number>`COALESCE(SUM(${tokenRecords.inputTokens}), 0)`,
        totalOutput: sql<number>`COALESCE(SUM(${tokenRecords.outputTokens}), 0)`,
        totalCacheRead: sql<number>`COALESCE(SUM(${tokenRecords.cacheRead}), 0)`,
        totalCacheWrite: sql<number>`COALESCE(SUM(${tokenRecords.cacheWrite}), 0)`,
      })
      .from(tokenRecords)
      .groupBy(tokenRecords.agent);

    const usageMap = new Map<string, typeof usageRows[number]>();
    for (const row of usageRows) {
      usageMap.set(row.agent, row);
    }

    const data = rows.map((row: any) => {
      const plain = decryptSecret(row.apiKeyEncrypted);
      const usage = usageMap.get(row.name);
      return {
        id: row.id,
        name: row.name,
        apiKey: plain,
        enabled: row.enabled === 1,
        lastUsedAt: row.lastUsedAt,
        createdAt: row.createdAt,
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
}

export async function POST(request: NextRequest) {
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
        })
        .returning();
      return NextResponse.json(
        {
          success: true,
          data: {
            id: result[0].id,
            name: result[0].name,
            apiKey: plainKey,
            enabled: true,
            lastUsedAt: null,
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
}
