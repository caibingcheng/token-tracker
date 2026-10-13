import { NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { db, initDatabase, namedRouteTargetsTable, namedRoutesTable, upstreamsTable } from "@/lib/db";
import { withAuth } from "@/lib/auth/guard";
import {
  isProtocol,
  parseEnabledModels,
  routeModelByProtocol,
  type Protocol,
  VALID_PROTOCOLS,
} from "@/lib/gateway/model-router";
import { simulateRoute } from "@/lib/gateway/simulate-route";
import type { SimNamedRoute, SimClassifierInfo } from "@/lib/gateway/simulate-route";
import type { UpstreamRoute } from "@/lib/gateway/model-router";
import { healthTracker } from "@/lib/gateway/proxy-deps";

interface UpstreamSummary {
  id: number;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  priority: number;
  enabled: boolean;
  enabledModels: string[];
  unhealthy: boolean;
  modelUnhealthy: string[];
}

interface CandidateInfo {
  upstreamId: number;
  name: string;
  priority: number;
  matchedPattern: string;
  matchType: "exact" | "wildcard";
  upstreamUnhealthy: boolean;
  modelUnavailable: boolean;
}

interface EffectiveRoute {
  winner: CandidateInfo | null;
  failover: boolean;
  allUnhealthy: boolean;
}

interface ResolvedRoute {
  protocol: Protocol;
  model: string;
  source: "named" | "auto";
  winner: CandidateInfo | null;
  candidates: CandidateInfo[];
  effective: EffectiveRoute;
  overridden?: boolean; // 同名自动路由被命名路由覆盖（合并行：命名链生效，自动候选见 shadowedCandidates）
  shadowedCandidates?: CandidateInfo[]; // 被命名路由覆盖的自动候选（仅同名合并行存在）
  namedRouteUnavailable?: boolean; // 命名路由存在但目标全部失效（upstream 禁用/删除）→ 网关 502
  classifier?: SimClassifierInfo | null; // 命名路由的分类器（kind='model' 请求时决策链首）
}

interface NamedTargetInfo {
  id: number;
  upstreamId: number | null; // null = auto 目标（按路由解析）
  targetModel: string;
  priority: number;
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

  // 健康状态：upstream 级 unhealthy 集合 + 每 upstream 的 model 级不可用集合（懒加载 + 顺带清理过期项）
  const upstreamUnhealthy = new Set<number>();
  const upstreamModelUnhealthy = new Map<number, Set<string>>();
  for (const row of rows) {
    if (!(await healthTracker.isHealthy(row.id))) {
      upstreamUnhealthy.add(row.id);
    }
    const models = await healthTracker.listModelUnhealthy(row.id);
    if (models.length > 0) {
      upstreamModelUnhealthy.set(row.id, new Set(models));
    }
  }

  const isCandidateHealthy = (upstreamId: number, model: string): boolean =>
    !upstreamUnhealthy.has(upstreamId) &&
    !(upstreamModelUnhealthy.get(upstreamId)?.has(model) ?? false);

  const upstreams: UpstreamSummary[] = rows.map((row: any) => ({
    id: row.id,
    name: row.name,
    protocol: isProtocol(row.protocol) ? row.protocol : "openai",
    baseUrl: row.baseUrl,
    priority: row.priority,
    enabled: row.enabled === 1,
    enabledModels: parseEnabledModels(row.enabledModels),
    unhealthy: upstreamUnhealthy.has(row.id),
    modelUnhealthy: Array.from(upstreamModelUnhealthy.get(row.id) ?? []),
  }));

  const upstreamRoutes = rows.map(toUpstreamRoute);
  const upstreamById = new Map<number, any>(rows.map((r: any) => [r.id, r]));

  // 命名路由 + 目标池（join upstream 取 classifier 名供 UI 展示）
  const routeRows = await db
    .select({ route: namedRoutesTable, upstream: upstreamsTable })
    .from(namedRoutesTable)
    .leftJoin(upstreamsTable, eq(namedRoutesTable.classifierUpstreamId, upstreamsTable.id));
  const targetRows = await db.select().from(namedRouteTargetsTable);
  const targetsByRoute = new Map<number, NamedTargetInfo[]>();
  for (const row of targetRows as any[]) {
    const list = targetsByRoute.get(row.namedRouteId) ?? [];
    list.push({
      id: row.id,
      upstreamId: row.upstreamId,
      targetModel: row.upstreamModel,
      priority: row.priority ?? 0,
    });
    targetsByRoute.set(row.namedRouteId, list);
  }
  Array.from(targetsByRoute.values()).forEach((list) => {
    list.sort((a, b) => a.priority - b.priority || a.id - b.id);
  });

  // 模拟器数据源：含 disabled（前端按 enabled 过滤），路由不过滤 upstream 状态（simulateRoute 自己判）
  const namedRoutes: SimNamedRoute[] = routeRows.map((row: any) => ({
    id: row.route.id,
    name: row.route.name,
    protocol: isProtocol(row.route.protocol) ? row.route.protocol : "openai",
    enabled: row.route.enabled === 1,
    classifierUpstreamName: row.upstream?.name ?? "(deleted)",
    classifierModel: row.route.classifierModel ?? "",
    classifierKind: row.route.classifierKind === "model" ? "model" : "priority",
    targets: targetsByRoute.get(row.route.id) ?? [],
  }));
  // 解析/列表共用：enabled 且至少一条目标的命名路由，按 protocol:name 索引（运行时 upstream 过滤在消费侧）
  const namedByKey = new Map<string, SimNamedRoute>();
  for (const r of namedRoutes) {
    if (r.enabled && r.targets.length > 0) {
      namedByKey.set(`${r.protocol}:${r.name}`, r);
    }
  }

  // 实际路由 = 健康过滤后链首；全部不健康时兜底 = 静态 priority 链首（与 proxy 兜底行为一致）。
  // 健康判定由调用方注入：自动路由按 upstream/model 级检查，命名路由按候选自身健康字段
  const computeEffective = (
    candidates: CandidateInfo[],
    isHealthy: (c: CandidateInfo) => boolean
  ): EffectiveRoute => {
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
  };

  const toCandidate = (
    c: { upstreamId: number; name: string; priority: number; matchedPattern: string; matchType: "exact" | "wildcard" },
    model: string
  ): CandidateInfo => ({
    ...c,
    upstreamUnhealthy: upstreamUnhealthy.has(c.upstreamId),
    modelUnavailable: upstreamModelUnhealthy.get(c.upstreamId)?.has(model) ?? false,
  });

  // 命名路由 resolve 行：候选池 = 目标池展开（显式目标单 hop；auto 目标按命名路由嵌套 >
  // 自动路由候选池展开，与 proxy 同一 simulateRoute 逻辑）。
  // LLM 分类器（kind=model，多目标）：真实链首请求时决策，静态无确定性 winner——winner 置 null，
  // 由 UI 在候选池标注 priority 最小目标为 fallback head；
  // 规则分类器（kind=priority，或单目标）：链首 = 首个健康目标（按优先级+可用性），静态 winner 即真实链首
  const buildNamedRoute = (route: SimNamedRoute, protocol: Protocol): ResolvedRoute => {
    const sim = simulateRoute(route.name, protocol, upstreams, namedRoutes);
    const candidates: CandidateInfo[] = sim.candidates.map((c) => ({
      upstreamId: c.upstreamId,
      name: c.name,
      priority: c.priority,
      matchedPattern: c.matchedPattern,
      matchType: c.matchType,
      upstreamUnhealthy: c.upstreamUnhealthy,
      modelUnavailable: c.modelUnavailable,
    }));
    const ruleBased = route.classifierKind !== "model" || candidates.length <= 1;
    return {
      protocol,
      model: route.name,
      source: "named",
      winner: ruleBased ? candidates[0] ?? null : null,
      candidates,
      effective: ruleBased
        ? computeEffective(candidates, (c) => !c.upstreamUnhealthy && !c.modelUnavailable)
        : { winner: null, failover: false, allUnhealthy: false },
      namedRouteUnavailable: sim.namedRouteUnavailable,
      classifier: {
        classifierUpstreamName: route.classifierUpstreamName,
        classifierModel: route.classifierModel,
        kind: route.classifierKind,
      },
    };
  };

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
    // 无该协议 upstream 时也要继续走 namedOnly/brokenNamed 分支：
    // 否则纯虚拟名命名路由（如全部 upstream 都是 openai 时的 anthropic 命名路由）
    // 永远不会出现在 routing table 里
    const models = concreteModelsByProtocol.get(protocol) ?? new Set<string>();
    const sortedModels = Array.from(models).sort((a, b) => a.localeCompare(b));
    for (const model of sortedModels) {
      const route = namedByKey.get(`${protocol}:${model}`);
      if (route) {
        // 同名命名路由复用自动行（不另起一行）：单行展示命名 failover 链（实际生效路由），
        // 被覆盖的自动候选保留在 shadowedCandidates 供展开详情溯源
        const { candidates: shadowed } = routeModelByProtocol(model, protocol, upstreamRoutes);
        resolvedRoutes.push({
          ...buildNamedRoute(route, protocol),
          shadowedCandidates: shadowed.map((c) =>
            toCandidate(
              {
                upstreamId: c.upstream.id,
                name: c.upstream.name,
                priority: c.upstream.priority,
                matchedPattern: c.matchedPattern,
                matchType: c.matchType,
              },
              model
            )
          ),
          overridden: true,
        });
        continue;
      }
      const { winner, candidates } = routeModelByProtocol(model, protocol, upstreamRoutes);
      const candidateInfos = candidates.map((c) =>
        toCandidate(
          {
            upstreamId: c.upstream.id,
            name: c.upstream.name,
            priority: c.upstream.priority,
            matchedPattern: c.matchedPattern,
            matchType: c.matchType,
          },
          model
        )
      );
      resolvedRoutes.push({
        protocol,
        model,
        source: "auto",
        winner: winner
          ? toCandidate(
              {
                upstreamId: winner.upstream.id,
                name: winner.upstream.name,
                priority: winner.upstream.priority,
                matchedPattern: winner.matchedPattern,
                matchType: winner.matchType,
              },
              model
            )
          : null,
        candidates: candidateInfos,
        effective: computeEffective(candidateInfos, (c) => isCandidateHealthy(c.upstreamId, model)),
      });
    }

    // 未配置在任何 upstream 的命名路由名（虚拟名转发场景）；按 (protocol, name) 分组
    const namedOnly = Array.from(namedByKey.values())
      .filter((r) => r.protocol === protocol && !models.has(r.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const route of namedOnly) {
      resolvedRoutes.push(buildNamedRoute(route, protocol));
    }

    // 目标全部失效的命名路由（enabled 但无有效目标）也列出，UI 标 namedRouteUnavailable
    const brokenNamed = namedRoutes
      .filter((r) => r.protocol === protocol && r.enabled && r.targets.length === 0 && !models.has(r.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const route of brokenNamed) {
      resolvedRoutes.push(buildNamedRoute(route, protocol));
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
      namedRoutes,
    },
  });
});
