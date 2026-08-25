import {
  findRoutingRules,
  routeModelByProtocol,
  type Protocol,
  type UpstreamRoute,
  type ModelCandidate,
} from "./model-router";

export interface SimUpstream {
  id: number;
  name: string;
  protocol: Protocol;
  priority: number;
  enabled: boolean;
  enabledModels: string[] | string;
  unhealthy: boolean;
  modelUnhealthy: string[];
}

export interface SimManualRule {
  id: number;
  name: string;
  protocol: Protocol;
  upstreamId: number;
  targetModel: string;
  priority: number;
}

export interface SimCandidate {
  upstreamId: number;
  name: string;
  priority: number;
  matchedPattern: string;
  matchType: "exact" | "wildcard";
  upstreamUnhealthy: boolean;
  modelUnavailable: boolean;
}

export interface SimEffective {
  winner: SimCandidate | null;
  failover: boolean;
  allUnhealthy: boolean;
}

export interface SkippedTarget {
  upstreamId: number;
  targetModel: string;
  reason: "disabled" | "missing";
}

export interface SimRouteResult {
  source: "manual" | "auto";
  winner: SimCandidate | null;
  candidates: SimCandidate[];
  effective: SimEffective;
  skipped: SkippedTarget[];
  manualRouteUnavailable: boolean;
}

// 对齐 /api/admin/models route.ts 的 computeEffective：健康链首为实际落点；
// 全部不健康时兜底 = 静态链首（allUnhealthy 且 winner = candidates[0]）
function computeEffective(
  candidates: SimCandidate[],
  isHealthy: (c: SimCandidate) => boolean
): SimEffective {
  const healthyFirst = candidates.filter(isHealthy);
  if (healthyFirst.length > 0) {
    return {
      winner: healthyFirst[0],
      failover: healthyFirst[0].upstreamId !== candidates[0]?.upstreamId,
      allUnhealthy: false,
    };
  }
  return {
    winner: candidates[0] ?? null,
    failover: false,
    allUnhealthy: candidates.length > 0,
  };
}

function toUpstreamRoute(u: SimUpstream): UpstreamRoute {
  return {
    id: u.id,
    name: u.name,
    protocol: u.protocol,
    baseUrl: "",
    priority: u.priority,
    enabled: u.enabled,
    enabledModels: u.enabledModels,
  };
}

function candidateFromMatch(c: ModelCandidate): SimCandidate {
  return {
    upstreamId: c.upstream.id,
    name: c.upstream.name,
    priority: c.upstream.priority,
    matchedPattern: c.matchedPattern,
    matchType: c.matchType,
    upstreamUnhealthy: false,
    modelUnavailable: false,
  };
}

function candidateFromRule(
  rule: SimManualRule,
  upstream: SimUpstream
): SimCandidate {
  return {
    upstreamId: upstream.id,
    name: upstream.name,
    priority: rule.priority,
    matchedPattern: rule.targetModel,
    matchType: "exact",
    upstreamUnhealthy: upstream.unhealthy,
    modelUnavailable: upstream.modelUnhealthy.includes(rule.targetModel),
  };
}

export function simulateRoute(
  model: string,
  protocol: Protocol,
  upstreams: SimUpstream[],
  rules: SimManualRule[]
): SimRouteResult {
  const upstreamById = new Map<number, SimUpstream>(upstreams.map((u) => [u.id, u]));

  const matched = findRoutingRules(model, protocol, rules);
  if (matched.length === 0) {
    // 自动路由：只考虑 enabled upstream（与其他查询口径一致）
    const enabled = upstreams.filter((u) => u.enabled);
    const { winner, candidates } = routeModelByProtocol(model, protocol, enabled.map(toUpstreamRoute));
    const toCandidateInfo = (c: ModelCandidate): SimCandidate => {
      const u = upstreamById.get(c.upstream.id)!;
      return {
        ...candidateFromMatch(c),
        upstreamUnhealthy: u.unhealthy,
        modelUnavailable: u.modelUnhealthy.includes(model),
      };
    };
    const candidateInfos = candidates.map(toCandidateInfo);
    return {
      source: "auto",
      winner: winner ? toCandidateInfo(winner) : null,
      candidates: candidateInfos,
      effective: computeEffective(candidateInfos, (c) => !c.upstreamUnhealthy && !c.modelUnavailable),
      skipped: [],
      manualRouteUnavailable: false,
    };
  }

  // 手动路由短路：跳过 upstream 禁用/不存在的目标（proxy 语义），
  // model 级健康按各目标自己的 targetModel 判定
  const skipped: SkippedTarget[] = [];
  const candidates: SimCandidate[] = [];
  for (const rule of matched) {
    const upstream = upstreamById.get(rule.upstreamId);
    if (!upstream) {
      skipped.push({ upstreamId: rule.upstreamId, targetModel: rule.targetModel, reason: "missing" });
      continue;
    }
    if (!upstream.enabled) {
      skipped.push({ upstreamId: rule.upstreamId, targetModel: rule.targetModel, reason: "disabled" });
      continue;
    }
    candidates.push(candidateFromRule(rule, upstream));
  }

  if (candidates.length === 0) {
    return {
      source: "manual",
      winner: null,
      candidates: [],
      effective: { winner: null, failover: false, allUnhealthy: false },
      skipped,
      manualRouteUnavailable: true,
    };
  }

  return {
    source: "manual",
    winner: candidates[0],
    candidates,
    effective: computeEffective(candidates, (c) => !c.upstreamUnhealthy && !c.modelUnavailable),
    skipped,
    manualRouteUnavailable: false,
  };
}
