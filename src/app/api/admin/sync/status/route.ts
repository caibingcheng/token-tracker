import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import { getSyncStatus } from "@/lib/sync/state";

export const GET = withAuth(async () => {
  return withSkipCache(async () => {
    const status = await getSyncStatus();
    return NextResponse.json({ success: true, data: status });
  });
});