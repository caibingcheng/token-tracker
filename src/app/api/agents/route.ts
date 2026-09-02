import { NextRequest, NextResponse } from "next/server";
import { db, initDatabase } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { withAuth } from "@/lib/auth/guard";
import { loadHiddenSources, loadAgentAliases } from "@/lib/auth/settings";
import { resolveAgentName, UNKNOWN_AGENT } from "@/lib/agent-utils";

export const dynamic = "force-dynamic";

const UNKNOWN_DISPLAY = "(unknown)";

// Agent 维度：默认返回派生工具名（按 user_agent 解析）；?dimension=key 保留旧行为
// （distinct agent 列 = 来源 key 名，含 hidden vk 过滤），供 DisplaySettings 的
// vk 建议列表使用（?dimension=key&includeHidden=1）。

export const GET = withAuth(async (request: NextRequest) => {
  await initDatabase();
  try {
    const { searchParams } = new URL(request.url);
    const includeHidden = searchParams.get("includeHidden") === "1";
    const dimension = searchParams.get("dimension");

    if (dimension === "key") {
      const hiddenSources = includeHidden ? null : await loadHiddenSources();
      const hiddenAgents = new Set(hiddenSources?.virtualKeys ?? []);

      const rows = await db
        .selectDistinct({
          agent: tokenRecords.agent,
        })
        .from(tokenRecords);

      const allAgents: string[] = rows
        .map((row: any) => row.agent)
        .filter((name: any): name is string => name !== null && name !== undefined);

      allAgents.sort((a, b) => a.localeCompare(b));

      const data = allAgents
        .filter((agent) => (includeHidden ? true : !hiddenAgents.has(agent)))
        .map((agent) => ({
          id: agent,
          name: agent === UNKNOWN_AGENT ? UNKNOWN_DISPLAY : agent,
        }));

      return NextResponse.json({
        success: true,
        data,
      });
    }

    // 默认：派生工具名列表（user_agent → resolveAgentName；NULL UA → unknown）
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