import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { withSkipCache } from "@/lib/db/cache";
import { getSyncStatus } from "@/lib/sync/state";
import { syncPusher } from "@/lib/sync/pusher";

export const GET = withAuth(async () => {
  // 启动兜底：进程启动后无网关流量场景，打开 Sync 页即 arm 60s 轮询（未配置零开销）
  syncPusher.kick();
  return withSkipCache(async () => {
    const status = await getSyncStatus();
    return NextResponse.json({ success: true, data: status });
  });
});