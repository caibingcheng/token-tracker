import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import {
  loadHiddenSources,
  setHiddenSourcesSetting,
  isValidHiddenSources,
  type HiddenSourcesConfig,
} from "@/lib/auth/settings";
import { withSkipCache } from "@/lib/db/cache";

// Hidden Sources 配置（settings 表 hidden_sources）：隐藏 vk / upstream 数据源
// 按名字隐藏（upstreams/virtualKeys）+ 全局「不计入总计」开关（excludeFromTotals）

export const GET = withAuth(async () => {
  return withSkipCache(async () => {
    const config = await loadHiddenSources();
    return NextResponse.json({ success: true, data: { config } });
  });
});

export const PUT = withAuth(async (request: NextRequest) => {
  return withSkipCache(async () => {
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
    }

    const config = body.config as unknown;
    if (!isValidHiddenSources(config)) {
      return NextResponse.json(
        {
          success: false,
          error: "Invalid config. Must include upstreams: string[], virtualKeys: string[], excludeFromTotals: boolean",
        },
        { status: 400 }
      );
    }

    await setHiddenSourcesSetting(config as HiddenSourcesConfig);
    return NextResponse.json({ success: true });
  });
});
