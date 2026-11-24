import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { dismissStarPrompt, isStarPromptDismissed } from "@/lib/auth/settings";
import { withSkipCache } from "@/lib/db/cache";

// 首次使用 star 提示状态（settings 表 star_prompt_dismissed，未保存 → 未提示过）。
// 存库里而不是 localStorage：换浏览器 / 清缓存后不会重复弹。
// 前端只在 dismissed=false 时弹，两个按钮（Star / No）以及 Esc、点遮罩都写 dismissed=true。

export const GET = withAuth(async () => {
  const dismissed = await isStarPromptDismissed();
  return NextResponse.json({ success: true, data: { dismissed } });
});

export const PUT = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  // 只接受 true：提示是单向的，不允许前端把已关闭状态改回未提示
  if (body.dismissed !== true) {
    return NextResponse.json(
      { success: false, error: "dismissed must be true" },
      { status: 400 }
    );
  }

  await withSkipCache(async () => {
    await dismissStarPrompt();
  });

  return NextResponse.json({ success: true });
});
