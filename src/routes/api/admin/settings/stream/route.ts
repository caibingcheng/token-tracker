import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import {
  getStreamIdleTimeoutMinutesSetting,
  setStreamIdleTimeoutMinutesSetting,
} from "@/lib/auth/settings";

// 流式代理空闲超时配置（settings 表，面板可调，无 env fallback）
// 语义：流式响应超过该时长未收到任何数据则中断（防卡死连接长期占用内存）

export const GET = withAuth(async () => {
  const stored = await getStreamIdleTimeoutMinutesSetting();
  return NextResponse.json({
    success: true,
    data: { value: stored },
  });
});

export const PUT = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  // 显式空值（null / ""）才清除配置（回退默认 30min）
  if (body.value === null || body.value === "") {
    const { deleteSetting } = await import("@/lib/auth/settings");
    await deleteSetting("stream_idle_timeout_minutes");
    return NextResponse.json({ success: true });
  }
  if (body.value === undefined) {
    return NextResponse.json({ success: false, error: "Missing value" }, { status: 400 });
  }

  const minutes = Number(body.value);
  if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) {
    return NextResponse.json(
      { success: false, error: "value must be an integer between 1 and 1440 minutes" },
      { status: 400 }
    );
  }

  await setStreamIdleTimeoutMinutesSetting(minutes);
  return NextResponse.json({ success: true });
});
