import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db/schema";

export async function POST(request: NextRequest) {
  await initDatabase();
  try {
    const body = await request.json();
    const apiKey = request.headers.get("X-API-Key")!;

    // 验证必填字段
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

    // 如果所有 token 数都为 0，则丢弃无效数据
    if (inputTokens === 0 && outputTokens === 0 && cacheRead === 0 && cacheWrite === 0) {
      return NextResponse.json(
        { success: true, skipped: true, message: "All token values are zero, record discarded" },
        { status: 200 }
      );
    }

    // 插入记录
    const result = await db
      .insert(tokenRecords)
      .values({
        apiKey,
        model: String(body.model),
        provider: String(body.provider),
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
}
