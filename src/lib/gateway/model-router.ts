import type { HeaderTransform } from "./header-transforms";
import type { ClassifierKind } from "./classifier/types";

export type Protocol = "openai" | "anthropic" | "gemini";

export const VALID_PROTOCOLS: Protocol[] = ["openai", "anthropic", "gemini"];

export function isProtocol(value: string): value is Protocol {
  return (VALID_PROTOCOLS as string[]).includes(value);
}

export interface UpstreamRoute {
  id: number;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  priority: number;
  enabled?: boolean;
  enabledModels?: string | string[];
  proxyUrl?: string | null; // HTTP CONNECT 代理明文 URL（解密后），null = 直连
  headerTransforms?: HeaderTransform[]; // 出站 header 变换（最后一棒）
  classifierModels?: string | null; // upstreams.classifier_models 原始 JSON（命名路由分类器声明）
}

// 命名路由：客户端请求的虚拟名 name + protocol → 目标 upstream 的真实模型。
// 自带目标池（多目标 failover 链）与可选分类器：
//   classifierKind='priority' = 无 LLM 分类器，链首取首个健康目标（按 priority）
//   classifierKind='model' = 由 classifierUpstreamId + classifierModel 指向的 LLM 分类器选链首
export interface NamedRoute {
  id: number;
  name: string;
  protocol: Protocol;
  instruction: string;
  classifierUpstreamId: number; // kind='priority' 时为占位 0
  classifierModel: string; // kind='priority' 时为占位 ''
  classifierKind: ClassifierKind;
  enabled: boolean;
}

// 命名路由的目标：failover 链的一跳，同时是分类器的候选项。
// upstreamId = null → 无 provider 目标：upstreamModel 按路由解析
//（命名路由嵌套展开 > 自动路由候选池，见 expandNamedRouteTargets）
export interface NamedRouteTarget {
  id: number;
  namedRouteId: number;
  upstreamId: number | null;
  upstreamModel: string;
  description: string | null;
  priority: number;
}

// 命名路由精确匹配（name+protocol 唯一），未命中或已禁用返回 null
export function findNamedRoute(
  model: string,
  protocol: Protocol,
  routes: NamedRoute[]
): NamedRoute | null {
  return (
    routes.find((r) => r.protocol === protocol && r.name === model && r.enabled) ?? null
  );
}

// 目标按 priority 升序、同 priority 按 id 升序（failover 链顺序）
export function sortNamedRouteTargets<T extends { id: number; priority: number }>(targets: T[]): T[] {
  return targets.slice().sort((a, b) => a.priority - b.priority || a.id - b.id);
}

// 命名路由展开后的具体一跳：上游对象 + 真实模型名（per-hop 改写按此计算）。
// targetId 始终是顶层命名路由的目标条目 id（分类器 / session binding 的决策粒度），
// 嵌套展开产生的 hop 继承其父目标条目的 targetId
export interface NamedRouteHopPlan {
  targetId: number;
  upstream: UpstreamRoute;
  targetModel: string;
}

// 把命名路由目标池展开为具体 hop 链（proxy 与 simulate-route 共用的纯逻辑）：
// - 显式目标（upstreamId 非空）→ 单 hop；upstream 不在启用列表 → 跳过（调用侧已预过滤）
// - 无 provider 目标（upstreamId = null）→ upstreamModel 先按命名路由精确匹配（嵌套，enabled 优先），
//   命中则递归展开该路由的目标池（其 pool 按 priority 静态排序，不调用其 LLM 分类器——
//   分类器是请求上下文决策，嵌套展开是静态解析）；未命中走自动路由候选池
//   （routeModelByProtocol：exact > wildcard，priority 升序，按 upstream 去重）
// - 防环：visited 为当前展开路径上的路由 id 集合，循环引用（A→B→A）时跳过该目标
export function expandNamedRouteTargets(opts: {
  protocol: Protocol;
  upstreams: UpstreamRoute[];
  routes: NamedRoute[];
  targets: NamedRouteTarget[]; // 顶层目标池（已按 priority 排序）
  resolveTargets: (routeId: number) => NamedRouteTarget[];
  rootRouteId: number;
  log?: (message: string) => void;
}): NamedRouteHopPlan[] {
  const { protocol, upstreams, routes, resolveTargets, rootRouteId, log } = opts;
  const upstreamById = new Map<number, UpstreamRoute>(upstreams.map((u) => [u.id, u]));

  const expandPool = (
    targets: NamedRouteTarget[],
    ownerTargetId: number | null,
    visited: Set<number>
  ): NamedRouteHopPlan[] => {
    const hops: NamedRouteHopPlan[] = [];
    for (const t of sortNamedRouteTargets(targets)) {
      if (t.upstreamId !== null) {
        const upstream = upstreamById.get(t.upstreamId);
        if (!upstream) continue; // 禁用/删除的 upstream：跳过（与既有语义一致）
        hops.push({ targetId: ownerTargetId ?? t.id, upstream, targetModel: t.upstreamModel });
        continue;
      }
      // 无 provider 目标：命名路由嵌套 > 自动路由
      const nested = routes.find(
        (r) => r.enabled && r.id !== rootRouteId && r.protocol === protocol && r.name === t.upstreamModel
      );
      if (nested) {
        if (visited.has(nested.id)) {
          log?.(
            `[gateway] named route nested cycle detected at "${t.upstreamModel}" (route id=${nested.id}); skipping target id=${t.id}`
          );
          continue;
        }
        const nextVisited = new Set(visited);
        nextVisited.add(nested.id);
        const nestedHops = expandPool(resolveTargets(nested.id), ownerTargetId ?? t.id, nextVisited);
        if (nestedHops.length === 0) {
          log?.(
            `[gateway] nested named route "${t.upstreamModel}" has no resolvable targets; skipping target id=${t.id}`
          );
        }
        hops.push(...nestedHops);
        continue;
      }
      const { candidates } = routeModelByProtocol(t.upstreamModel, protocol, upstreams);
      const seen = new Set<number>();
      for (const c of candidates) {
        if (seen.has(c.upstream.id)) continue;
        seen.add(c.upstream.id);
        hops.push({ targetId: ownerTargetId ?? t.id, upstream: c.upstream, targetModel: t.upstreamModel });
      }
      if (seen.size === 0) {
        log?.(
          `[gateway] auto target "${t.upstreamModel}" matches no upstream; skipping target id=${t.id}`
        );
      }
    }
    return hops;
  };

  return expandPool(opts.targets, null, new Set([rootRouteId]));
}

// 前缀通配（如 "gpt-*"）匹配："gpt-4o" 命中，但 "gpt" 本身不命中
export function wildcardMatch(pattern: string, model: string): boolean {
  if (!pattern.endsWith("*")) return false;
  const prefix = pattern.slice(0, -1);
  return prefix.length > 0 && model.startsWith(prefix);
}

export function modelMatchesPattern(pattern: string, model: string): boolean {
  if (pattern === model) return true;
  return wildcardMatch(pattern, model);
}

export function parseEnabledModels(raw: string | string[] | null | undefined): string[] {
  if (Array.isArray(raw)) return raw;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m) => typeof m === "string") : [];
  } catch {
    return [];
  }
}

// 从 Gemini URL path 提取 model：/v1beta/models/{model}:generateContent
export function extractGeminiModel(path: string): string | null {
  const match = path.match(/^\/v1(?:\/?beta)?\/models\/([^/:]+)/);
  return match ? match[1]! : null;
}

// 根据请求 path 判断协议：
//   /v1beta/* → gemini；/v1/messages → anthropic；其余 → openai
export function detectRequestProtocol(path: string): Protocol {
  if (path.startsWith("/v1beta")) return "gemini";
  if (path === "/v1/messages") return "anthropic";
  return "openai";
}

// 从请求提取 model：Gemini 从 URL path，OpenAI/Anthropic 从 body.model
export function extractRequestModel(path: string, body: unknown): string | null {
  const geminiModel = extractGeminiModel(path);
  if (geminiModel) return geminiModel;
  if (typeof body === "object" && body !== null) {
    const model = (body as Record<string, unknown>).model;
    if (typeof model === "string" && model.length > 0) return model;
  }
  return null;
}

export interface RouteMatch {
  upstream: UpstreamRoute;
  matchedPattern: string;
}

export type MatchType = "exact" | "wildcard";

export interface ModelCandidate {
  upstream: UpstreamRoute;
  matchedPattern: string;
  matchType: MatchType;
}

function upstreamMatchesModel(upstream: UpstreamRoute, model: string): ModelCandidate[] {
  const patterns = parseEnabledModels(upstream.enabledModels);
  const candidates: ModelCandidate[] = [];
  for (const pattern of patterns) {
    if (pattern === model) {
      candidates.push({ upstream, matchedPattern: pattern, matchType: "exact" });
    } else if (modelMatchesPattern(pattern, model)) {
      candidates.push({ upstream, matchedPattern: pattern, matchType: "wildcard" });
    }
  }
  return candidates;
}

function pickWinner(candidates: ModelCandidate[]): ModelCandidate | null {
  if (candidates.length === 0) return null;
  // 精确匹配优先；同类型按 priority 升序；priority 相同保持原始顺序
  return candidates.slice().sort((a, b) => {
    if (a.matchType !== b.matchType) {
      return a.matchType === "exact" ? -1 : 1;
    }
    if (a.upstream.priority !== b.upstream.priority) {
      return a.upstream.priority - b.upstream.priority;
    }
    return 0;
  })[0];
}

// 精确匹配优先于前缀通配；多命中取 priority 最小者
export function routeModel(model: string, upstreams: UpstreamRoute[]): RouteMatch | null {
  const enabled = upstreams.filter((u) => u.enabled !== false);

  const exact = enabled.find((u) => {
    const patterns = parseEnabledModels(u.enabledModels);
    return patterns.includes(model);
  });
  if (exact) {
    return { upstream: exact, matchedPattern: model };
  }

  let best: RouteMatch | null = null;
  for (const upstream of enabled) {
    const patterns = parseEnabledModels(upstream.enabledModels);
    for (const pattern of patterns) {
      if (modelMatchesPattern(pattern, model)) {
        if (!best || upstream.priority < best.upstream.priority) {
          best = { upstream, matchedPattern: pattern };
        }
      }
    }
  }
  return best;
}

// 在指定 protocol 的启用 upstream 中查找所有匹配候选
export function findCandidatesByProtocol(
  model: string,
  protocol: Protocol,
  upstreams: UpstreamRoute[]
): ModelCandidate[] {
  const enabled = upstreams.filter((u) => u.enabled !== false && u.protocol === protocol);
  const candidates: ModelCandidate[] = [];
  for (const upstream of enabled) {
    candidates.push(...upstreamMatchesModel(upstream, model));
  }
  return candidates;
}

// 在指定 protocol 下决选出最终路由，同时返回所有候选
export function routeModelByProtocol(
  model: string,
  protocol: Protocol,
  upstreams: UpstreamRoute[]
): { winner: ModelCandidate | null; candidates: ModelCandidate[] } {
  const candidates = findCandidatesByProtocol(model, protocol, upstreams);
  const winner = pickWinner(candidates);
  // 候选按胜出顺序排列：精确优先，priority 升序
  const ordered = candidates.slice().sort((a, b) => {
    if (a.matchType !== b.matchType) {
      return a.matchType === "exact" ? -1 : 1;
    }
    if (a.upstream.priority !== b.upstream.priority) {
      return a.upstream.priority - b.upstream.priority;
    }
    return 0;
  });
  return { winner, candidates: ordered };
}
