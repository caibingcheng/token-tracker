import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import {
  loadAgentAliases,
  setAgentAliasesSetting,
  isValidAgentAliases,
} from "@/lib/auth/settings";

// Agent Aliases（Agent 维度手动映射，Display pane 编辑）

export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  const rules = await loadAgentAliases();
  return NextResponse.json({ success: true, data: rules });
});

export const PUT = withAuth(async (request: NextRequest) => {
  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: "Invalid JSON body" }, { status: 400 });
  }
  if (!isValidAgentAliases(body.rules)) {
    return NextResponse.json(
      { success: false, error: "Invalid rules: array of {name, aliases[]} with no extra keys" },
      { status: 400 }
    );
  }
  await setAgentAliasesSetting(body.rules);
  const { ip, userAgent } = extractClientInfo(request);
  await recordAuditLog({
    action: "agent_aliases_updated",
    targetType: "system",
    ip,
    userAgent,
    details: { count: body.rules.length },
  });
  return NextResponse.json({ success: true });
});