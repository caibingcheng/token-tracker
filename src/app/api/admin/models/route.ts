import { NextResponse } from "next/server";
import { db, initDatabase, upstreamsTable } from "@/lib/db";
import { withAuth } from "@/lib/auth/guard";
import {
  isProtocol,
  parseEnabledModels,
  routeModelByProtocol,
  type Protocol,
  VALID_PROTOCOLS,
} from "@/lib/gateway/model-router";
import type { UpstreamRoute } from "@/lib/gateway/model-router";

interface UpstreamSummary {
  id: number;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  priority: number;
  enabled: boolean;
  enabledModels: string[];
}

interface CandidateInfo {
  upstreamId: number;
  name: string;
  priority: number;
  matchedPattern: string;
  matchType: "exact" | "wildcard";
}

interface ResolvedRoute {
  protocol: Protocol;
  model: string;
  winner: CandidateInfo | null;
  candidates: CandidateInfo[];
}

interface WildcardInfo {
  pattern: string;
  upstreamId: number;
  name: string;
  priority: number;
}

function toUpstreamRoute(row: any): UpstreamRoute {
  return {
    id: row.id,
    name: row.name,
    protocol: row.protocol,
    baseUrl: row.baseUrl,
    priority: row.priority,
    enabled: row.enabled === 1,
    enabledModels: parseEnabledModels(row.enabledModels),
  };
}

export const GET = withAuth(async () => {
  await initDatabase();
  const rows = await db.select().from(upstreamsTable).orderBy(upstreamsTable.priority);

  const upstreams: UpstreamSummary[] = rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    protocol: isProtocol(row.protocol) ? row.protocol : "openai",
    baseUrl: row.baseUrl,
    priority: row.priority,
    enabled: row.enabled === 1,
    enabledModels: parseEnabledModels(row.enabledModels),
  }));

  const upstreamRoutes = rows.map(toUpstreamRoute);

  // 按 protocol 收集具体模型（非通配）和通配模式
  const concreteModelsByProtocol = new Map<Protocol, Set<string>>();
  const wildcardPatternsByProtocol = new Map<Protocol, WildcardInfo[]>();

  for (const u of upstreams) {
    if (!u.enabled) continue;
    for (const pattern of u.enabledModels) {
      if (!pattern) continue;
      if (pattern.endsWith("*")) {
        const list = wildcardPatternsByProtocol.get(u.protocol) ?? [];
        list.push({
          pattern,
          upstreamId: u.id,
          name: u.name,
          priority: u.priority,
        });
        wildcardPatternsByProtocol.set(u.protocol, list);
      } else {
        const set = concreteModelsByProtocol.get(u.protocol) ?? new Set<string>();
        set.add(pattern);
        concreteModelsByProtocol.set(u.protocol, set);
      }
    }
  }

  const resolvedRoutes: ResolvedRoute[] = [];
  for (const protocol of VALID_PROTOCOLS) {
    const models = concreteModelsByProtocol.get(protocol);
    if (!models) continue;
    const sortedModels = Array.from(models).sort((a, b) => a.localeCompare(b));
    for (const model of sortedModels) {
      const { winner, candidates } = routeModelByProtocol(model, protocol, upstreamRoutes);
      resolvedRoutes.push({
        protocol,
        model,
        winner: winner
          ? {
              upstreamId: winner.upstream.id,
              name: winner.upstream.name,
              priority: winner.upstream.priority,
              matchedPattern: winner.matchedPattern,
              matchType: winner.matchType,
            }
          : null,
        candidates: candidates.map((c) => ({
          upstreamId: c.upstream.id,
          name: c.upstream.name,
          priority: c.upstream.priority,
          matchedPattern: c.matchedPattern,
          matchType: c.matchType,
        })),
      });
    }
  }

  const wildcardPatterns: Record<string, WildcardInfo[]> = {};
  for (const protocol of VALID_PROTOCOLS) {
    const list = wildcardPatternsByProtocol.get(protocol);
    if (list) {
      wildcardPatterns[protocol] = list.sort(
        (a, b) => a.priority - b.priority || a.pattern.localeCompare(b.pattern)
      );
    } else {
      wildcardPatterns[protocol] = [];
    }
  }

  return NextResponse.json({
    success: true,
    data: {
      upstreams,
      protocols: VALID_PROTOCOLS,
      resolvedRoutes,
      wildcardPatternsByProtocol: wildcardPatterns,
    },
  });
});
