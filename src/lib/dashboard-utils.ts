import { db } from "@/lib/db";
import { tokenRecords } from "@/lib/db";
import { resolveProviderFilter } from "@/lib/provider-utils";
import { resolveNormalizedModelFilter } from "@/lib/model-utils";

export interface DashboardFilters {
  providerFilter: string[] | null;
  modelFilter: string[] | null;
}

export class FilterValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FilterValidationError";
  }
}

export async function resolveDashboardFilters(
  provider: string,
  model: string
): Promise<DashboardFilters> {
  let providerFilter: string[] | null = null;
  if (provider !== "all") {
    const allProviderRows = await db
      .selectDistinct({ provider: tokenRecords.provider })
      .from(tokenRecords);
      const allProviderNames: string[] = allProviderRows
        .map((r: any) => r.provider)
        .filter((n: any): n is string => n !== null && n !== undefined);

    providerFilter = resolveProviderFilter(provider, allProviderNames);
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

    modelFilter = resolveNormalizedModelFilter(model, allRawModels, providerByModel);
  }

  return { providerFilter, modelFilter };
}

export function validateFilterOrThrow(
  provider: string,
  providerFilter: string[] | null,
  model: string,
  modelFilter: string[] | null
): void {
  if (provider !== "all" && (!providerFilter || providerFilter.length === 0)) {
    throw new FilterValidationError(`Unknown provider: ${provider}`);
  }
  if (model !== "all" && (!modelFilter || modelFilter.length === 0)) {
    throw new FilterValidationError(`Unknown model: ${model}`);
  }
}
