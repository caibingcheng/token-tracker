import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import {
  getSessionTtlHoursSetting,
  setSessionTtlHoursSetting,
} from "@/lib/auth/settings";

// 会话 token TTL 配置（settings 表，面板优先于 env SESSION_TOKEN_TTL_HOURS）
// 语义：只影响新签发的 token，已签发 token 的 exp 不变

export const GET = withAuth(async () => {
  const stored = await getSessionTtlHoursSetting();
  const envRaw = process.env.SESSION_TOKEN_TTL_HOURS;
  return NextResponse.json({
    success: true,
    data: {
      value: stored,
      envValue: envRaw ?? null,
      envOverridden: stored !== null && envRaw !== undefined && envRaw.trim() !== "",
    },
  });
});

export const PUT = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  // 显式空值（null / ""）才清除配置（回退 env/默认）；缺失 value 字段视为客户端错误
  if (body.value === null || body.value === "") {
    const { deleteSetting } = await import("@/lib/auth/settings");
    await deleteSetting("session_token_ttl_hours");
    return NextResponse.json({ success: true });
  }
  if (body.value === undefined) {
    return NextResponse.json({ success: false, error: "Missing value" }, { status: 400 });
  }

  const hours = Number(body.value);
  if (!Number.isInteger(hours) || hours < 1 || hours > 720) {
    return NextResponse.json(
      { success: false, error: "value must be an integer between 1 and 720 hours" },
      { status: 400 }
    );
  }

  await setSessionTtlHoursSetting(hours);
  return NextResponse.json({ success: true });
});
