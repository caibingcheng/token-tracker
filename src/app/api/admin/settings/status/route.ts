import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import {
  getStatusPageConfig,
  setStatusPageConfig,
  isValidStatusPageConfig,
  type StatusPageConfig,
} from "@/lib/auth/settings";

// Status 公开页配置（settings 表 status_page_config）

export const GET = withAuth(async () => {
  const config = await getStatusPageConfig();
  return NextResponse.json({ success: true, data: { config } });
});

export const PUT = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }

  const config = body.config as unknown;
  if (!isValidStatusPageConfig(config)) {
    return NextResponse.json(
      { success: false, error: "Invalid config. Must include enabled: boolean and all element booleans" },
      { status: 400 }
    );
  }

  await setStatusPageConfig(config as StatusPageConfig);
  return NextResponse.json({ success: true });
});
