import { db } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import {
  resolveProviderFilters,
  loadHiddenProviderGroups,
} from "@/lib/provider-utils";
import { resolveNormalizedModelFilters } from "@/lib/model-utils";
import { loadModelAliases, loadAgentAliases } from "@/lib/auth/settings";
import {
  resolveAgentUserAgentsMulti,
  type AgentUaFilter,
} from "@/lib/agent-utils";

export interface DashboardFilters {
  providerFilter: string[] | null;
  modelFilter: string[] | null;
  agentUaFilter: AgentUaFilter;
}

export class FilterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterValidationError";
  }
}

// 多选筛选：每个维度可能是空数组（= 不筛选）或多个值，值取并集。
// 任一名未命中 → FilterValidationError（路由转 400）。
export async function resolveDashboardFilters(
  providers: string[],
  models: string[],
  agents: string[]
): Promise<DashboardFilters> {
  const groups = await loadHiddenProviderGroups();

  let providerFilter: string[] | null = null;
  if (providers.length > 0) {
    const allProviderRows = await db
      .selectDistinct({ provider: tokenRecords.provider })
      .from(tokenRecords);
    const allProviderNames: string[] = allProviderRows
      .map((r: any) => r.provider)
      .filter((n: any): n is string => n !== null && n !== undefined);

    const resolved = resolveProviderFilters(providers, allProviderNames, groups);
    if (resolved.unknown.length > 0) {
      throw new FilterValidationError(
        `Unknown provider: ${resolved.unknown.join(", ")}`
      );
    }
    providerFilter = resolved.filter;
  }

  let modelFilter: string[] | null = null;
  if (models.length > 0) {
    // 与 /api/models 、/api/records 一致：归一化必须带手动 model aliases，
    // 否则配置 alias 后同一个合法筛选项会在 Dashboard 被判 Unknown model
    const aliases = await loadModelAliases();
    const allModelRows = await db
      .selectDistinct({ model: tokenRecords.model, provider: tokenRecords.provider })
      .from(tokenRecords);
    const allRawModels: string[] = allModelRows
      .map((r: any) => r.model)
      .filter((n: any): n is string => n !== null && n !== undefined);
    const providerByModel = new Map<string, string>();
    for (const row of allModelRows) {
      if (row.model && row.provider) {
        providerByModel.set(row.model, row.provider);
      }
    }

    const resolved = resolveNormalizedModelFilters(
      models,
      allRawModels,
      providerByModel,
      groups,
      aliases
    );
    if (resolved.unknown.length > 0) {
      throw new FilterValidationError(
        `Unknown model: ${resolved.unknown.join(", ")}`
      );
    }
    modelFilter = resolved.filter;
  }

  // Agent 维度（派生工具名）：反找 agent 名 → 命中该 agent 的 UA 集合
  let agentUaFilter: AgentUaFilter = null;
  if (agents.length > 0) {
    const aliases = await loadAgentAliases();
    const uaRows = await db
      .selectDistinct({ ua: tokenRecords.userAgent })
      .from(tokenRecords);
    const allUas: Array<string | null> = uaRows.map((r: any) => r.ua);
    const resolved = resolveAgentUserAgentsMulti(agents, allUas, aliases);
    if (resolved.unknownNames.length > 0) {
      throw new FilterValidationError(
        `Unknown agent: ${resolved.unknownNames.join(", ")}`
      );
    }
    agentUaFilter = resolved.filter;
  }

  return { providerFilter, modelFilter, agentUaFilter };
}
