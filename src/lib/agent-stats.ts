import { toNum } from "@/lib/number-utils";
import type { StatItem } from "@/lib/model-utils";
import { resolveAgentName, type AgentAliasRule } from "@/lib/agent-utils";

// Agent 维度（派生工具名）聚合：与 provider 维度不同，agent 名不是表里的列，
// 由 user_agent 查询时派生（resolveAgentName），因此分组只能按原始 UA 做，
// 再在应用层按派生名合并。调用方按需截断 Top N。

export interface AgentStat {
  agent: string;
  totalInput: number;
  totalInputCached: number;
  totalOutput: number;
  count: number;
}

export function aggregateAgents(
  rows: Array<StatItem & { userAgent?: string | null }>,
  aliases: AgentAliasRule[] = []
): AgentStat[] {
  const map = new Map<string, AgentStat>();

  for (const row of rows) {
    const agent = resolveAgentName(row.userAgent ?? null, aliases);
    const totalInput = toNum(row.totalInput);
    const totalInputCached = toNum(row.totalInputCached);
    const totalOutput = toNum(row.totalOutput);
    const count = toNum(row.count);
    const existing = map.get(agent);

    if (existing) {
      existing.totalInput += totalInput;
      existing.totalInputCached += totalInputCached;
      existing.totalOutput += totalOutput;
      existing.count += count;
    } else {
      map.set(agent, {
        agent,
        totalInput,
        totalInputCached,
        totalOutput,
        count,
      });
    }
  }

  return Array.from(map.values()).sort((a, b) => b.totalInput - a.totalInput);
}
