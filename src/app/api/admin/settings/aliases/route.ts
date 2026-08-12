import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import {
  loadModelAliases,
  setModelAliasesSetting,
  isValidModelAliases,
} from "@/lib/auth/settings";

// Model Aliases 归一化配置（Display pane）

export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  const rules = await loadModelAliases();
  return NextResponse.json({ success: true, data: rules });
});

export const PUT = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isValidModelAliases(body.rules)) {
    return NextResponse.json(
      { success: false, error: "Invalid rules: array of {name, aliases[]} with no extra keys" },
      { status: 400 }
    );
  }
  await setModelAliasesSetting(body.rules);
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "model_aliases_updated",
    targetType: "system",
    ip,
    userAgent,
    details: { count: body.rules.length },
  });
  return NextResponse.json({ success: true });
});
