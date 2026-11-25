import { NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { clearRecoveryCodeReminder } from "@/lib/auth/recovery-codes";

// 「我已检查」：清除 recovery code 登录提醒标记（独立轻量路由，不与其他操作耦合）
export const DELETE = withAuth(async () => {
  await clearRecoveryCodeReminder();
  return NextResponse.json({ success: true });
});
