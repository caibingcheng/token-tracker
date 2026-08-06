import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import {
  getHiddenProvidersSetting,
  setHiddenProvidersSetting,
} from "@/lib/auth/settings";
import { parseHiddenProviderGroups } from "@/lib/provider-utils";
import { withSkipCache } from "@/lib/db/cache";

// Display 配置：HIDDEN_PROVIDERS 分组语法（settings 表，面板优先于 env）

export const GET = withAuth(async () => {
  const stored = await getHiddenProvidersSetting();
  const envRaw = process.env.HIDDEN_PROVIDERS ?? "";
  return NextResponse.json({
    success: true,
    data: {
      // 面板保存的值（null 表示从未保存，此时 env 生效）
      value: stored ?? "",
      // env 兜底值：仅当 settings 未保存时生效，UI 用于提示
      envValue: envRaw,
      // settings 已保存时 env 被静默忽略
      envOverridden: stored !== null && envRaw.trim() !== "",
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

  if (typeof body.value !== "string") {
    return NextResponse.json({ success: false, error: "value must be a string" }, { status: 400 });
  }
  const raw = body.value;
  // 保存前语法校验：空 pattern 的组（如 "a:;" / ";;"）视为非法语法
  const parsed = parseHiddenProviderGroups(raw);
  if (raw.trim() !== "" && parsed.length === 0) {
    return NextResponse.json(
      { success: false, error: "Invalid group syntax: no valid patterns" },
      { status: 400 }
    );
  }
  if (parsed.some((g) => g.patterns.length === 0)) {
    return NextResponse.json(
      { success: false, error: "Invalid group syntax: a group has no patterns" },
      { status: 400 }
    );
  }

  await withSkipCache(async () => {
    await setHiddenProvidersSetting(raw);
  });

  return NextResponse.json({ success: true });
});
