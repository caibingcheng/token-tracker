import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import {
  getHiddenProvidersSetting,
  setHiddenProvidersSetting,
} from "@/lib/auth/settings";
import {
  parseStoredHiddenProviderGroups,
  isValidHiddenProviderGroups,
} from "@/lib/provider-utils";
import { withSkipCache } from "@/lib/db/cache";

// Display 配置：hidden_providers 分组（settings 表存 JSON 数组，唯一来源；
// 旧字符串语法读取时自动迁移）

export const GET = withAuth(async () => {
  const stored = await getHiddenProvidersSetting();
  const groups =
    stored !== null ? parseStoredHiddenProviderGroups(stored) : [];
  return NextResponse.json({
    success: true,
    data: {
      groups,
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
