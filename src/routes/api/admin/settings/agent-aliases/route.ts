import { NextRequest, NextResponse } from "next/server";
import { withAuth } from "@/lib/auth/guard";
import { recordAuditLog, extractClientInfo } from "@/lib/admin/audit";
import {
  loadAgentAliases,
  setAgentAliasesSetting,
  isValidAgentAliases,
} from "@/lib/auth/settings";
import { db, initDatabase, tokenRecords } from "@/lib/db";
import { extractUaToken, classifyAgentToken } from "@/lib/agent-utils";

// Agent Aliases（Agent 维度手动映射，Display pane 编辑）

export const dynamic = "force-dynamic";

export const GET = withAuth(async () => {
  const rules = await loadAgentAliases();

  // 已观测 UA token 及其解析结果（只读展示，驱动「数据库中存在的 UA」列表）；
  // 反找同款 distinct 全表扫描，个人规模 + 查询缓存可接受
  await initDatabase();
  const uaRows = await db
    .selectDistinct({ ua: tokenRecords.userAgent })
    .from(tokenRecords);
  const tokenSet = new Map<string, { name: string; source: string }>();
  for (const row of uaRows as Array<{ ua: string | null }>) {
    if (!row.ua) continue; // NULL UA → (unknown)，非 token 语义
    const token = extractUaToken(row.ua);
    if (!token || tokenSet.has(token)) continue;
    tokenSet.set(token, classifyAgentToken(token, rules));
  }
  const observed = Array.from(tokenSet.entries())
    .map(([token, r]) => ({ token, name: r.name, source: r.source }))
    .sort((a, b) => a.token.localeCompare(b.token));

  return NextResponse.json({ success: true, data: { rules, observed } });
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