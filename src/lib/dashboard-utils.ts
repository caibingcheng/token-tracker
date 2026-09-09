import { db } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { resolveProviderFilter, loadHiddenProviderGroups } from "@/lib/provider-utils";
import { resolveNormalizedModelFilter } from "@/lib/model-utils";
import { loadAgentAliases } from "@/lib/auth/settings";
import {
  resolveAgentUserAgents,
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

export async function resolveDashboardFilters(
  provider: string,
  model: string,
  agent?: string
): Promise<DashboardFilters> {
  const groups = await loadHiddenProviderGroups();
  let providerFilter: string[] | null = null;
  if (provider !== "all") {
    const allProviderRows = await db
      .selectDistinct({ provider: tokenRecords.provider })
      .from(tokenRecords);
      const allProviderNames: string[] = allProviderRows
        .map((r: any) => r.provider)
        .filter((n: any): n is string => n !== null && n !== undefined);

    providerFilter = resolveProviderFilter(provider, allProviderNames, groups);
  }

  let modelFilter: string[] | null = null;
  if (model !== "all") {
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

    modelFilter = resolveNormalizedModelFilter(model, allRawModels, providerByModel, groups);
  }

  // Agent 维度（派生工具名）：反找 agent 名 → 命中该 agent 的 UA 集合
  let agentUaFilter: AgentUaFilter = null;
  if (agent && agent !== "all") {
    const aliases = await loadAgentAliases();
    const uaRows = await db
      .selectDistinct({ ua: tokenRecords.userAgent })
      .from(tokenRecords);
    const allUas: Array<string | null> = uaRows.map((r: any) => r.ua);
    agentUaFilter = resolveAgentUserAgents(agent, allUas, aliases);
    if (!agentUaFilter) {
      throw new FilterValidationError(`Unknown agent: ${agent}`);
    }
  }

  return { providerFilter, modelFilter, agentUaFilter };
}

export function validateFilterOrThrow(
  provider: string,
  providerFilter: string[] | null,
  model: string,
  modelFilter: string[] | null,
  agent?: string
): void {
  if (provider !== "all" && (!providerFilter || providerFilter.length === 0)) {
    throw new FilterValidationError(`Unknown provider: ${provider}`);
  }
  if (model !== "all" && (!modelFilter || modelFilter.length === 0)) {
    throw new FilterValidationError(`Unknown model: ${model}`);
  }
}