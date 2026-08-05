import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, virtualKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";

interface Params {
  params: { id: string };
}

export async function PATCH(request: NextRequest, { params }: Params) {
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const row = (
      await db.select().from(virtualKeysTable).where(eq(virtualKeysTable.id, id))
    )[0];
    if (!row) {
      return NextResponse.json({ success: false, error: "Virtual key not found" }, { status: 404 });
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
    if (body.enabled !== undefined) {
      values.enabled = body.enabled ? 1 : 0;
    }
    if (Object.keys(values).length === 0) {
      return NextResponse.json({ success: false, error: "No fields to update" }, { status: 400 });
    }

    try {
      await db.update(virtualKeysTable).set(values).where(eq(virtualKeysTable.id, id));
      return NextResponse.json({ success: true });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("UNIQUE")) {
        return NextResponse.json({ success: false, error: "Virtual key name already exists" }, { status: 409 });
      }
      console.error("Update virtual key error:", err);
      return NextResponse.json({ success: false, error: "Internal server error" }, { status: 500 });
    }
  });
}

export async function DELETE(request: NextRequest, { params }: Params) {
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const row = (
      await db.select().from(virtualKeysTable).where(eq(virtualKeysTable.id, id))
    )[0];
    if (!row) {
      return NextResponse.json({ success: false, error: "Virtual key not found" }, { status: 404 });
    }
    await db.delete(virtualKeysTable).where(eq(virtualKeysTable.id, id));
    return NextResponse.json({ success: true });
  });
}
