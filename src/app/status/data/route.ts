import { NextRequest, NextResponse } from "next/server";
import { getStatusPageConfig } from "@/lib/auth/settings";
import {
  queryStatusData,
  getStatusCacheKey,
  getCachedStatusData,
  setCachedStatusData,
  checkStatusRateLimit,
  type StatusData,
} from "@/lib/status-query";
import { getRateLimitKey } from "@/lib/net/client-ip";

// /status/data —— 唯一公开的用量统计端点（有意设计，不经过 auth 中间件）。
// 安全边界（与四层防漏配合）：
// 1. 路由位于 /status 下，middleware matcher（/api/*）天然不匹配，auth 层零改动
// 2. fail-closed：settings 未启用时返回 404
// 3. 数据面最小化：不接受任何过滤参数，仅 tzOffset；响应按启用元素裁剪
// 4. 限流 + 60s 响应缓存防滥用
// 5. force-dynamic：禁止构建期预渲染烘焙 enabled/disabled 决策

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  try {
    if (checkStatusRateLimit(getRateLimitKey(request))) {
      return NextResponse.json(
        { success: false, error: "Too many requests" },
        { status: 429 }
      );
    }

    const { searchParams } = new URL(request.url);
    const tzOffsetParam = searchParams.get("tzOffset");

    let timezoneOffsetMinutes = 0;
    if (tzOffsetParam !== null) {
      timezoneOffsetMinutes = parseInt(tzOffsetParam, 10);
      if (
        Number.isNaN(timezoneOffsetMinutes) ||
        timezoneOffsetMinutes < -720 ||
        timezoneOffsetMinutes > 720
      ) {
        return NextResponse.json(
          { success: false, error: "Invalid tzOffset" },
          { status: 400 }
        );
      }
    }

    const config = await getStatusPageConfig();
    if (!config.enabled) {
      return NextResponse.json(
        { success: false, error: "Status page is disabled" },
        { status: 404 }
      );
    }

    const cacheKey = getStatusCacheKey(timezoneOffsetMinutes);
    const cached = getCachedStatusData(cacheKey);
    if (cached) {
      return NextResponse.json({ success: true, data: cached });
    }

    const data: StatusData = await queryStatusData(config, timezoneOffsetMinutes);
    setCachedStatusData(cacheKey, data);

    return NextResponse.json({ success: true, data });
  } catch (error) {
    console.error("Status data error:", error);
    return NextResponse.json(
      { success: false, error: "Internal server error" },
      { status: 500 }
    );
  }
}
