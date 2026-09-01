import { NextResponse } from "next/server";
import { desc } from "drizzle-orm";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import { db, initDatabase, syncInstancesTable } from "@/lib/db";

export const GET = withAuth(async () => {
  return withSkipCache(async () => {
    await initDatabase();
    const rows = await db.select().from(syncInstancesTable).orderBy(desc(syncInstancesTable.updatedAt));
    return NextResponse.json({
      success: true,
      data: rows.map((row: any) => ({
        instance: row.instance,
        epoch: row.epoch,
        lastRecordId: Number(row.lastRecordId) || 0,
        updatedAt: row.updatedAt ?? null,
      })),
    });
  });
});