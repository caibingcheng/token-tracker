import { NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { withAuth } from "@/lib/auth/guard";
import { loadAgentAliases } from "@/lib/auth/settings";
import { resolveAgentName, UNKNOWN_AGENT } from "@/lib/agent-utils";

export const dynamic = "force-dynamic";

const UNKNOWN_DISPLAY = "(unknown)";

// Agent 维度：返回派生工具名（按 user_agent 解析，NULL UA → unknown）。

export const GET = withAuth(async () => {
  await initDatabase();
  try {
    // 派生工具名列表（user_agent → resolveAgentName；NULL UA → unknown）
    const aliases = await loadAgentAliases();
    const uaRows = await db
      .selectDistinct({ ua: tokenRecords.userAgent })
      .from(tokenRecords);

    const agentSet = new Set<string>();
    let hasUnknown = false;
    for (const row of uaRows as Array<{ ua: string | null }>) {
      const name = resolveAgentName(row.ua, aliases);
      if (name === UNKNOWN_AGENT) {
        hasUnknown = true;
      } else {
        agentSet.add(name);
      }
    }

    const data = Array.from(agentSet)
      .sort((a, b) => a.localeCompare(b))
      .map((name) => ({
        id: name,
        name,
      }));
    if (hasUnknown) {
      data.push({ id: UNKNOWN_AGENT, name: UNKNOWN_DISPLAY });
    }

    return NextResponse.json({
      success: true,
      data,
    });
  } catch (error) {
    console.error("Error fetching agents:", error);
    return NextResponse.json(
      {
        success: false,
        error: "Failed to fetch agents",
      },
      { status: 500 }
    );
  }
});