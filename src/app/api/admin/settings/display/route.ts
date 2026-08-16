import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import {
  getHiddenProvidersSetting,
  setHiddenProvidersSetting,
} from "@/lib/auth/settings";
import {
  parseHiddenProviderGroups,
  parseStoredHiddenProviderGroups,
  isValidHiddenProviderGroups,
} from "@/lib/provider-utils";
import { withSkipCache } from "@/lib/db/cache";

// Display 配置：HIDDEN_PROVIDERS 分组（settings 表存 JSON 数组，面板优先于 env；
// 旧字符串语法读取时自动迁移）

export const GET = withAuth(async () => {
  const stored = await getHiddenProvidersSetting();
  const envRaw = process.env.HIDDEN_PROVIDERS ?? "";
  const groups =
    stored !== null
      ? parseStoredHiddenProviderGroups(stored)
      : parseHiddenProviderGroups(envRaw);
  return NextResponse.json({
    success: true,
    data: {
      // 生效中的分组（settings 已保存 → 面板值；否则 env 解析结果）
      groups,
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

  const groups = body.groups;
  if (!isValidHiddenProviderGroups(groups)) {
    return NextResponse.json(
      { success: false, error: "Invalid groups: array of {name, patterns[]} with no extra keys" },
      { status: 400 }
    );
  }

  await withSkipCache(async () => {
    await setHiddenProvidersSetting(groups);
  });

  return NextResponse.json({ success: true });
});
