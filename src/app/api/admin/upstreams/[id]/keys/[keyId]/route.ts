import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, upstreamKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";

interface Params {
  params: { id: string; keyId: string };
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return withSkipCache(async () => {
    await initDatabase();
    const keyId = Number(params.keyId);
    const row = (
      await db.select().from(upstreamKeysTable).where(eq(upstreamKeysTable.id, keyId))
    )[0];
    if (!row) {
      return NextResponse.json({ success: false, error: "Upstream key not found" }, { status: 404 });
    }

    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const values: Record<string, unknown> = {};
    if (body.enabled !== undefined) {
      values.enabled = body.enabled ? 1 : 0;
    }
    if (body.lastStatus !== undefined) {
      values.lastStatus = typeof body.lastStatus === "string" ? body.lastStatus : null;
    }
    if (Object.keys(values).length === 0) {
      return NextResponse.json({ success: false, error: "No fields to update" }, { status: 400 });
    }

    await db.update(upstreamKeysTable).set(values).where(eq(upstreamKeysTable.id, keyId));
    return NextResponse.json({ success: true });
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withSkipCache(async () => {
    await initDatabase();
    const keyId = Number(params.keyId);
    const row = (
      await db.select().from(upstreamKeysTable).where(eq(upstreamKeysTable.id, keyId))
    )[0];
    if (!row) {
      return NextResponse.json({ success: false, error: "Upstream key not found" }, { status: 404 });
    }
    await db.delete(upstreamKeysTable).where(eq(upstreamKeysTable.id, keyId));
    return NextResponse.json({ success: true });
  });
}
