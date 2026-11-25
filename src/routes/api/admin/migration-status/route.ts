import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { getMigrationIssues } from "@/lib/db/migration-status";

// 迁移降级启动的可见性出口：Admin banner 读它。
// 空数组 = 本次启动所有迁移跑通（settings 中的 key 已被删）。
export const GET = withAuth(async () => {
  const data = await getMigrationIssues();
  return NextResponse.json({ success: true, data });
});
