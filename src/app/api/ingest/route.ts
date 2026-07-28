import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";

export async function POST(request: NextRequest) {
  return withSkipCache(async () => {
    await initDatabase();
    try {
      const body = await request.json();

      if (!body.model || !body.provider) {
        return NextResponse.json(
          { success: false, error: "Missing required fields: model, provider" },
          { status: 400 }
        );
      }

      const inputTokens = Math.max(0, Number(body.inputTokens) || 0);
      const outputTokens = Math.max(0, Number(body.outputTokens) || 0);
      const cacheRead = Math.max(0, Number(body.cacheRead) || 0);
      const cacheWrite = Math.max(0, Number(body.cacheWrite) || 0);

      if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) {
        return NextResponse.json(
          { success: true, skipped: true, message: "All token values are zero, record discarded" },
          { status: 200 }
        );
      }

      const provider = String(body.provider);
      const model = String(body.model);
      const agent = body.agent ? String(body.agent) : "unknown";

      const result = await db
        .insert(tokenRecords)
        .values({
          model,
          provider,
          agent,
          inputTokens,
          outputTokens,
          cacheRead,
          cacheWrite,
        })
        .returning();

      return NextResponse.json({ success: true, id: result[0].id });
    } catch (error) {
      console.error("Ingest error:", error);
      return NextResponse.json(
        { success: false, error: "Internal server error" },
        { status: 500 }
      );
    }
  });
}