import {
  routeModelByProtocol,
  sortNamedRouteTargets,
  expandNamedRouteTargets,
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

// 命名路由目标（与 proxy 的 NamedRouteTargetInfo 对齐）；upstreamId = null → auto 目标
export interface SimNamedTarget {
  id: number;
  upstreamId: number | null;
  targetModel: string;
  priority: number;
}

// 命名路由（与 proxy.ts 语义对齐）：目标池按 priority 构成 failover 链；
// classifierKind='model' 时链首由分类器在请求时决策（静态模拟取 priority 最小目标作 fallback head）
export interface SimNamedRoute {
  id: number;
  name: string;
  protocol: Protocol;
  enabled: boolean;
  classifierUpstreamName: string;
  classifierModel: string;
  classifierKind: "model" | "priority";
  targets: SimNamedTarget[];
}

export interface SimClassifierInfo {
  classifierUpstreamName: string;
  classifierModel: string;
  kind: "model" | "priority";
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
  upstreamId: number | null; // null = auto 目标解析不出任何 upstream
  targetModel: string;
  reason: "disabled" | "missing" | "unresolved";
}

export interface SimRouteResult {
  source: "named" | "auto";
  winner: SimCandidate | null;
  candidates: SimCandidate[];
  effective: SimEffective;
  skipped: SkippedTarget[];
  // 命名路由存在但目标全部失效 → 网关返回 502 named_route_unavailable
  namedRouteUnavailable: boolean;
  classifier: SimClassifierInfo | null;
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
      // 引用比较：同 upstream 可挂多个不同 targetModel（链内对象按引用区分 hop）
      failover: healthyFirst[0] !== candidates[0],
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

const isCandidateHealthy = (c: SimCandidate): boolean =>
  !c.upstreamUnhealthy && !c.modelUnavailable;

export function simulateRoute(
  model: string,
  protocol: Protocol,
  upstreams: SimUpstream[],
  namedRoutes: SimNamedRoute[] = []
): SimRouteResult {
  const upstreamById = new Map<number, SimUpstream>(upstreams.map((u) => [u.id, u]));

  // 命名路由解析（对齐 proxy.ts）：enabled + 同名同协议 + 至少一条有效目标
  //（upstream 必须存在且启用；无效目标进 skipped 可见）
  const simRoute =
    namedRoutes.find((r) => r.enabled && r.name === model && r.protocol === protocol) ?? null;

  if (simRoute) {
    const skipped: SkippedTarget[] = [];
    // 显式目标中 upstream 缺失/禁用的进 skipped（与 proxy 语义一致：展开时跳过）
    const pool = sortNamedRouteTargets(simRoute.targets).filter((target) => {
      if (target.upstreamId === null) return true; // auto 目标不在此过滤
      const upstream = upstreamById.get(target.upstreamId);
      if (!upstream) {
        skipped.push({ upstreamId: target.upstreamId, targetModel: target.targetModel, reason: "missing" });
        return false;
      }
      if (!upstream.enabled) {
        skipped.push({ upstreamId: target.upstreamId, targetModel: target.targetModel, reason: "disabled" });
        return false;
      }
      return true;
    });

    // 目标池 → 展开 hop 链（显式单 hop；auto：命名路由嵌套 > 自动路由候选池；防环）
    const enabledUpstreams = upstreams.filter((u) => u.enabled);
    const priorityByTargetId = new Map<number, number>(pool.map((t) => [t.id, t.priority]));
    const plans = expandNamedRouteTargets({
      protocol,
      upstreams: enabledUpstreams.map(toUpstreamRoute),
      routes: namedRoutes.map((r) => ({
        id: r.id,
        name: r.name,
        protocol: r.protocol,
        instruction: "",
        classifierUpstreamId: 0,
        classifierModel: "",
        classifierKind: r.classifierKind,
        enabled: r.enabled,
      })),
      targets: pool.map((t) => ({
        id: t.id,
        namedRouteId: simRoute.id,
        upstreamId: t.upstreamId,
        upstreamModel: t.targetModel,
        description: null,
        priority: t.priority,
      })),
      resolveTargets: (routeId) =>
        (namedRoutes.find((r) => r.id === routeId)?.targets ?? []).map((t) => ({
          id: t.id,
          namedRouteId: routeId,
          upstreamId: t.upstreamId,
          upstreamModel: t.targetModel,
          description: null,
          priority: t.priority,
        })),
      rootRouteId: simRoute.id,
    });

    // auto 目标解析不出任何 upstream → unresolved skipped
    const hopCountByTarget = new Map<number, number>();
    for (const p of plans) hopCountByTarget.set(p.targetId, (hopCountByTarget.get(p.targetId) ?? 0) + 1);
    for (const t of pool) {
      if (t.upstreamId === null && (hopCountByTarget.get(t.id) ?? 0) === 0) {
        skipped.push({ upstreamId: null, targetModel: t.targetModel, reason: "unresolved" });
      }
    }

    const candidates: SimCandidate[] = plans.map((p) => {
      const u = upstreamById.get(p.upstream.id)!;
      return {
        upstreamId: u.id,
        name: u.name,
        priority: priorityByTargetId.get(p.targetId) ?? 0,
        matchedPattern: p.targetModel,
        matchType: "exact" as const,
        upstreamUnhealthy: u.unhealthy,
        modelUnavailable: u.modelUnhealthy.includes(p.targetModel),
      };
    });

    if (candidates.length === 0) {
      return {
        source: "named",
        winner: null,
        candidates: [],
        effective: { winner: null, failover: false, allUnhealthy: false },
        skipped,
        namedRouteUnavailable: true,
        classifier: null,
      };
    }

    // 单目标跳过分类器（无决策必要，与 proxy 一致）：链首即该目标
    const ruleBased = simRoute.classifierKind !== "model" || candidates.length <= 1;
    return {
      source: "named",
      winner: ruleBased ? candidates[0] : null,
      candidates,
      effective: ruleBased
        ? computeEffective(candidates, isCandidateHealthy)
        : { winner: null, failover: false, allUnhealthy: false },
      skipped,
      namedRouteUnavailable: false,
      classifier: {
        classifierUpstreamName: simRoute.classifierUpstreamName,
        classifierModel: simRoute.classifierModel,
        kind: simRoute.classifierKind,
      },
    };
  }

  // 无命名路由 → 自动路由：只考虑 enabled upstream（与其他查询口径一致）
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
    effective: computeEffective(candidateInfos, isCandidateHealthy),
    skipped: [],
    namedRouteUnavailable: false,
    classifier: null,
  };
}
