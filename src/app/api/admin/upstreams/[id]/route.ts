import { NextRequest, NextResponse } from "next/server";
import { eq, count } from "drizzle-orm";
import { db, initDatabase, upstreamsTable, upstreamKeysTable } from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { withAuth } from "@/lib/auth/guard";
import { isProtocol, parseEnabledModels } from "@/lib/gateway/model-router";

interface Params {
  params: { id: string };
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
  return {
    ...upstream,
    enabled: upstream.enabled === 1,
    enabledModels: parseEnabledModels(upstream.enabledModels),
    balance: upstream.balance ?? null,
    balanceUpdatedAt: upstream.balanceUpdatedAt ?? null,
    keys: keyRows.map((k: any) => ({
      id: k.id,
      enabled: k.enabled === 1,
      lastStatus: k.lastStatus,
      createdAt: k.createdAt,
    })),
  };
}

export const GET = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const upstream = await findUpstream(id);
    if (!upstream) {
      return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 404 });
    }
    return NextResponse.json({ success: true, data: await withKeys(upstream) });
  });
});

export const PATCH = withAuth(async (request: NextRequest, ctx: any) => {
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
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
      values.name = name;
    }
    if (typeof body.protocol === "string") {
      if (!isProtocol(body.protocol)) {
        return NextResponse.json({ success: false, error: "Invalid protocol" }, { status: 400 });
      }
      values.protocol = body.protocol;
    }
    if (typeof body.baseUrl === "string") {
      const baseUrl = body.baseUrl.trim().replace(/\/+$/, "");
      if (!/^https?:\/\//.test(baseUrl)) {
        return NextResponse.json({ success: false, error: "baseUrl must start with http(s)://" }, { status: 400 });
      }
      values.baseUrl = baseUrl;
    }
    if (Array.isArray(body.enabledModels)) {
      values.enabledModels = JSON.stringify(
        body.enabledModels.filter((m) => typeof m === "string")
      );
    }
    if (body.priority !== undefined && Number.isFinite(Number(body.priority))) {
      values.priority = Number(body.priority);
    }
    if (body.enabled !== undefined) {
      values.enabled = body.enabled ? 1 : 0;
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

    if (Object.keys(values).length === 0) {
      return NextResponse.json({ success: false, error: "No fields to update" }, { status: 400 });
    }

    try {
      const result = await db
        .update(upstreamsTable)
        .set(values)
        .where(eq(upstreamsTable.id, id))
        .returning();
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
  const { params } = ctx as Params;
  return withSkipCache(async () => {
    await initDatabase();
    const id = Number(params.id);
    const upstream = await findUpstream(id);
    if (!upstream) {
      return NextResponse.json({ success: false, error: "Upstream not found" }, { status: 404 });
    }
    await db.delete(upstreamsTable).where(eq(upstreamsTable.id, id));
    return NextResponse.json({ success: true });
  });
});
