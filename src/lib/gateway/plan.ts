// relay 执行计划（buildPlan）——中心侧唯一决策点，仅中心 import。
//
// 与 proxy.ts 的链组装**刻意不共用代码**（抽取 hopLoop 的回归风险大于收益）：
// 一致性由 plan.contract.test.ts 的 fixture 断言保证（同一份 deps 假实现分别跑
// proxy.ts 与 buildPlan()，比较实际尝试序列）。这里只复用底层原语：
// routeModelByProtocol / findNamedRoute / expandNamedRouteTargets / 健康过滤 /
// givenUp 剔除 / collectEnabledModels / stripQueryKey / joinUrlPath。
//
// 纯逻辑 + 依赖注入，可单测；不读 DB、不读 env、不发请求。
import {
  MAX_RETRY,
  collectEnabledModels,
  isModelAllowedByVirtualKey,
  stripQueryKey,
} from "./proxy";
import type {
  NamedRouteInfo,
  NamedRouteTargetInfo,
  ProxyDeps,
  RecordUsageMeta,
  RunClassifierFn,
  VirtualKeyInfo,
} from "./proxy";
import {
  expandNamedRouteTargets,
  findNamedRoute,
  routeModel,
  routeModelByProtocol,
  sortNamedRouteTargets,
} from "./model-router";
import type { Protocol, UpstreamRoute } from "./model-router";
import { computeSessionId, computeSessionIdFromInput } from "./session";
import { checkQuota, hasQuotaLimits } from "./quota";
import { parseClassifierModels } from "./classifier/types";
import type { HeaderTransform } from "./header-transforms";
import { joinUrlPath } from "./url-utils";
import { isLoopbackHost, isPrivateHost } from "./url-guard";

// 非流式单次尝试超时（与 proxy.ts 的 NON_STREAMING_TIMEOUT_MS 同值；
// 该常量在 proxy.ts 未导出，这里是 relay 侧的唯一副本，contract test 钉住相等）
export const PLAN_NON_STREAMING_TIMEOUT_MS = 60_000;

export type PlanMode = "router" | "responses-create" | "responses-subresource" | "models";

export type ContinueCondition =
  | "401"
  | "403"
  | "404"
  | "429"
  | "5xx"
  | "network"
  | "timeout";
export type StopCondition = "2xx" | "4xx-other";

// 失败响应的保留规则（§10.1.1，分 mode）：
// - last-4xx       → 只保留最后一个业务 4xx（router / responses-create）
// - last-business  → 保留最后一个业务响应（含 429/5xx），responses-subresource 用
// - null           → 不保留
export type PlanPassthrough = "last-4xx" | "last-business" | null;

export interface PlanKey {
  id: number;
  apiKey: string;
}

export interface PlanHop {
  hopIndex: number;
  upstreamId: number;
  keyId: number;
  url: string;
  realModel: string | null; // responses-subresource 为 null（不改写 body）
  requiresPrivateNetwork: boolean;
  retries: number; // 每个 key 总尝试次数（= MAX_RETRY），不是「重试次数」
  continueOn: ContinueCondition[];
  stopOn: StopCondition[];
  passthrough: PlanPassthrough;
  timeoutMs: number | null; // 流式 null；非流式 60s；subresource 恒 60s
  suppressHealth: ("403" | "404")[];
  // 收到这些状态码时**跳过该 upstream 剩余 key**（直连侧语义：403/404 是 upstream 级判定，
  // 换 upstream 而不是换 key；401 则是换 key，不列入）。relay 只读这个字段，不写 if。
  skipSiblingsOn: ("403" | "404")[];
  // ---- 内部字段（不进 plan 响应，仅供中心构造 lease） ----
  upstreamName: string;
  proxyUrl: string | null;
  headerTransforms: HeaderTransform[];
}

export interface BuildPlanInput {
  virtualKey: VirtualKeyInfo; // 已鉴权
  mode: PlanMode;
  protocol: Protocol;
  path: string; // 已净化、已剥 /raw 前缀；**含 query**（key 已剥）
  model: string | null; // responses-*/models 模式为 null
  responseId: string | null; // 仅 responses-subresource
  nativeSessionId: string | null; // 原生 header 原值（已截断 256）
  sessionInput: string | null; // 指纹素材（system 尾 1024 + 首条 user 前 1024，无分隔符）
  hasMessages: boolean;
  stream: boolean | undefined;
  userAgent: string | null;
  estimatedInputTokens: number;
  /** 仅中心内部可用（测试/直连复用）：relay 不传 body，LLM 分类器因此不执行 */
  bodyJson?: unknown;
}

export interface PlanDeps {
  loadUpstreams: () => Promise<UpstreamRoute[]>;
  // 与 resolveUpstreamKeys(upstreamId) 的区别：返回 key id（写 device_plans.hops_json +
  // 做 lease 的 AAD 绑定）
  resolveUpstreamKeys: (upstreamId: number) => Promise<PlanKey[]>;
  loadNamedRoutes?: () => Promise<NamedRouteInfo[]>;
  loadNamedRouteTargets?: (namedRouteId: number) => Promise<NamedRouteTargetInfo[]>;
  runClassifier?: RunClassifierFn;
  session?: ProxyDeps["session"];
  health?: ProxyDeps["health"];
  lookupResponseOwner?: (responseId: string) => Promise<number | null>;
  quota?: ProxyDeps["quota"];
  // 分类器自身消耗的 token 也要记账（与直连路径同口径）；relay 不经过这条链时无开销
  onClassifierUsage?: (meta: RecordUsageMeta) => Promise<void>;
  log?: (message: string) => void;
}

export interface BuildPlanError {
  type: string;
  code: string;
  message: string;
}

export type BuildPlanResult =
  | {
      ok: true;
      hops: PlanHop[];
      quota: { reservedTokens: number; reservedRpm: number };
      modelsSnapshot?: string[];
      /** 指纹原值（header transforms 的 ${var.sessionId} 用它，与直连同一口径） */
      sessionId: string;
      /** 路由粘性 binding 键（原生 header 派生或指纹） */
      routeSessionId: string;
      /** token_records.session_id 用；不写 usage 的 mode 为 null */
      recordSessionId: string | null;
    }
  | { ok: false; status: number; error: BuildPlanError };

// mode 由 path 派生（与 proxy.ts 的分支顺序一致），不信任 relay 自报
export function resolvePlanMode(method: string, path: string): PlanMode {
  if (method === "GET" && path.endsWith("/models")) return "models";
  if (path.startsWith("/v1/responses/")) return "responses-subresource";
  if (path === "/v1/responses") return "responses-create";
  return "router";
}

function planError(status: number, code: string, message: string): BuildPlanResult {
  return { ok: false, status, error: { type: code, code, message } };
}

type RouteHop = { upstream: UpstreamRoute; targetModel: string };

// 私网/环回字面地址判定（域名需 DNS，交给 relay 侧连接时校验）
function requiresPrivateNetwork(upstream: UpstreamRoute): boolean {
  for (const raw of [upstream.baseUrl, upstream.proxyUrl ?? null]) {
    if (!raw) continue;
    try {
      const host = new URL(raw).hostname;
      if (isPrivateHost(host) || isLoopbackHost(host)) return true;
    } catch {
      // 非法 URL 不在这里判定：relay 的 assertOutboundUrlAllowed 会 fail-closed
    }
  }
  return false;
}

const ROUTER_CONTINUE_ON: ContinueCondition[] = [
  "401",
  "403",
  "404",
  "429",
  "5xx",
  "network",
  "timeout",
];
const ROUTER_STOP_ON: StopCondition[] = ["2xx", "4xx-other"];
// 三种 mode 共用：403/404 表示「该 upstream 不认这个 model / response id」，换 upstream 而不是换 key
const SKIP_SIBLINGS_ON: ("403" | "404")[] = ["403", "404"];

export async function buildPlan(
  input: BuildPlanInput,
  deps: PlanDeps,
  now: number = Date.now()
): Promise<BuildPlanResult> {
  const { virtualKey, protocol, mode } = input;
  const { pathname, query } = splitPlanPath(input.path);
  // 会话指纹：subresource 无 model，直连侧用 path 当 model 项（buildSessionId(null, path, ...)），
  // 这里同口径（且用去 query 的 pathname）—— header transforms 的 ${var.sessionId} 两条入口必须相等
  const sessionModel = input.model ?? pathname;
  // 指纹原值（body 素材派生）：routeSessionId / recordSessionId 的基底
  const fingerprint = computeSessionId(
    computeSessionIdFromInput(
      input.sessionInput ?? "",
      sessionModel,
      virtualKey.id,
      protocol
    )
  );
  // 直连侧名为 sessionId 的请求级值：原生 header 优先，否则指纹（header transforms 的 ${var.sessionId}）
  const useNativeSession =
    input.nativeSessionId !== null &&
    mode !== "responses-subresource" &&
    mode !== "models";
  const sessionId = useNativeSession ? (input.nativeSessionId as string) : fingerprint;
  const routeSessionId = useNativeSession
    ? computeSessionId(
        `native\u0000${input.nativeSessionId}\u0000${sessionModel}\u0000${virtualKey.id}\u0000${protocol}`
      )
    : fingerprint;
  // 写库口径门槛与直连一致：无原生 header 且无 messages（/raw、Gemini contents）→ NULL
  const recordSessionId =
    mode === "router" || mode === "responses-create"
      ? (input.nativeSessionId ?? (input.hasMessages ? fingerprint : null))
      : null;

  const quotaOf = (reservedTokens: number, reservedRpm: number) => ({
    reservedTokens,
    reservedRpm,
  });

  // ---- models：无上游、无 hop、无配额，只回快照（逐字复刻 proxy.ts 的 GET /models 分支） ----
  if (mode === "models") {
    const upstreams = await deps.loadUpstreams();
    const routes = deps.loadNamedRoutes ? await deps.loadNamedRoutes() : [];
    const namedNames = routes
      .filter((r) => r.protocol === protocol && r.enabled)
      .map((r) => r.name);
    const models = collectEnabledModels(upstreams, namedNames).filter((id) =>
      isModelAllowedByVirtualKey(virtualKey, id)
    );
    return {
      ok: true,
      hops: [],
      quota: quotaOf(0, 0),
      modelsSnapshot: models,
      sessionId,
      routeSessionId,
      recordSessionId: null,
    };
  }

  // ---- responses 子资源：无 model 可路由，按 priority 遍历全部 openai upstream ----
  if (mode === "responses-subresource") {
    return buildSubresourcePlan(input, deps, now, {
      sessionId,
      routeSessionId,
      recordSessionId,
    });
  }

  const model = input.model;
  if (!model) {
    return planError(400, "invalid_request_error", "Unable to determine model from request");
  }
  if (model.length > 256) {
    return planError(400, "invalid_request_error", "Model name too long");
  }
  if (!isModelAllowedByVirtualKey(virtualKey, model)) {
    return planError(
      403,
      "model_not_allowed",
      `Model not allowed for this virtual key: ${model}`
    );
  }

  const upstreams = await deps.loadUpstreams();
  let namedRoute = false;
  let hops: RouteHop[] = [];

  const hopHealth = async (hop: RouteHop): Promise<boolean> => {
    const upDown = deps.health && !(await deps.health.isHealthy(hop.upstream.id));
    const modelDown =
      deps.health?.isModelHealthy &&
      !(await deps.health.isModelHealthy(hop.upstream.id, hop.targetModel));
    return !(upDown || modelDown);
  };

  // ---- 命名路由：命中后目标池整体构成 failover 链（同名自动路由完全失效） ----
  const allRoutes = deps.loadNamedRoutes ? await deps.loadNamedRoutes() : [];
  const route = findNamedRoute(model, protocol, allRoutes);
  if (route) {
    namedRoute = true;

    const targetsByRouteId = new Map<number, NamedRouteTargetInfo[]>();
    const loadTargetsDeep = async (routeId: number, visited: Set<number>): Promise<void> => {
      if (visited.has(routeId)) return;
      visited.add(routeId);
      const targets = deps.loadNamedRouteTargets ? await deps.loadNamedRouteTargets(routeId) : [];
      targetsByRouteId.set(routeId, targets);
      for (const t of targets) {
        if (t.upstreamId !== null) continue;
        const nested = allRoutes.find(
          (r) => r.enabled && r.protocol === protocol && r.name === t.targetModel
        );
        if (nested && !visited.has(nested.id)) await loadTargetsDeep(nested.id, visited);
      }
    };
    await loadTargetsDeep(route.id, new Set());

    const toPoolEntry = (routeId: number) => (t: NamedRouteTargetInfo) => ({
      id: t.id,
      namedRouteId: routeId,
      upstreamId: t.upstreamId,
      upstreamModel: t.targetModel,
      description: t.description,
      priority: t.priority,
    });
    const expandTarget = (t: NamedRouteTargetInfo): RouteHop[] =>
      expandNamedRouteTargets({
        protocol,
        upstreams,
        routes: allRoutes,
        targets: [toPoolEntry(route.id)(t)],
        resolveTargets: (id) => (targetsByRouteId.get(id) ?? []).map(toPoolEntry(id)),
        rootRouteId: route.id,
        log: deps.log,
      }).map((p) => ({ upstream: p.upstream, targetModel: p.targetModel }));

    const targets = sortNamedRouteTargets(targetsByRouteId.get(route.id) ?? []);
    if (targets.length === 0) {
      return planError(
        502,
        "named_route_unavailable",
        "Named route target unavailable: no valid upstream targets"
      );
    }
    const hopsByTarget = new Map<number, RouteHop[]>();
    for (const t of targets) hopsByTarget.set(t.id, expandTarget(t));
    // givenUp 在分类器/预选之前剔除（否则白付一次 LLM 分类器成本）
    if (deps.health?.isGivenUp) {
      const isGivenUp = deps.health.isGivenUp;
      const loaded = new Set<number>();
      for (const t of targets) {
        const list = hopsByTarget.get(t.id) ?? [];
        for (const h of list) {
          if (loaded.has(h.upstream.id)) continue;
          loaded.add(h.upstream.id);
          await deps.health.isHealthy(h.upstream.id); // 触发 ensureLoaded，isGivenUp 只读内存
        }
        hopsByTarget.set(
          t.id,
          list.filter((h) => !isGivenUp(h.upstream.id))
        );
      }
    }
    const expandable = targets.filter((t) => (hopsByTarget.get(t.id)?.length ?? 0) > 0);
    if (expandable.length === 0) {
      return planError(
        502,
        "named_route_unavailable",
        "Named route target unavailable: no valid upstream targets"
      );
    }

    // session 粘性（目标粒度决策、hop 粒度匹配）
    let preselected: NamedRouteTargetInfo | null = null;
    let boundHop: RouteHop | null = null;
    if (deps.session && expandable.length > 1) {
      const binding = deps.session.getBinding(routeSessionId);
      if (binding && binding.targetModel !== undefined) {
        for (const t of expandable) {
          const hit = hopsByTarget.get(t.id)!.find(
            (h) => h.upstream.id === binding.upstreamId && h.targetModel === binding.targetModel
          );
          if (hit) {
            preselected = t;
            boundHop = hit;
            break;
          }
        }
      }
    }

    // 链首目标：binding 预选 > LLM 分类器（kind='model'）> 首个有健康 hop 的目标
    let selected: NamedRouteTargetInfo | null = preselected;
    let pinHop: RouteHop | null = boundHop;
    if (!selected && expandable.length > 1) {
      const headHopOf = (t: NamedRouteTargetInfo) => hopsByTarget.get(t.id)![0];
      const writeBinding = (t: NamedRouteTargetInfo, hop?: RouteHop) => {
        if (deps.session) {
          const h = hop ?? headHopOf(t);
          deps.session.setBinding(routeSessionId, h.upstream.id, h.targetModel);
        }
      };
      if (route.classifierKind === "model" && deps.runClassifier && deps.session) {
        const classifierUpstream = upstreams.find((u) => u.id === route.classifierUpstreamId);
        const entry = classifierUpstream
          ? (parseClassifierModels(classifierUpstream.classifierModels).find(
              (e) => e.model === route.classifierModel
            ) ?? { model: route.classifierModel, type: "jev-systemone" as const })
          : undefined;
        if (classifierUpstream && entry) {
          const classifierStart = Date.now();
          const result = await deps.runClassifier({
            upstream: classifierUpstream,
            entry,
            instruction: route.instruction,
            routes: expandable.map((t) => ({
              routeId: t.id,
              targetModel: t.targetModel,
              description: t.description,
            })),
            bodyJson: input.bodyJson ?? null,
            protocol,
          });
          if (result.routeId !== null) {
            selected = expandable.find((t) => t.id === result.routeId) ?? null;
          }
          if (deps.onClassifierUsage) {
            deps
              .onClassifierUsage({
                model: route.classifierModel,
                provider: classifierUpstream.name,
                agent: virtualKey.name,
                inputTokens: result.usage?.inputTokens ?? 0,
                outputTokens: result.usage?.outputTokens ?? 0,
                cacheRead: 0,
                cacheWrite: 0,
                status: "classifier",
                latencyMs: Date.now() - classifierStart,
                virtualKeyId: virtualKey.id,
                userAgent: input.userAgent,
                sessionId: recordSessionId,
                requestModel: model,
              })
              .catch(() => {});
          }
        } else {
          deps.log?.(
            `[gateway] named route "${model}": classifier upstream/entry not configured or unavailable; falling back to priority order`
          );
        }
        selected ??= expandable[0];
        writeBinding(selected);
      } else {
        if (route.classifierKind === "model") {
          deps.log?.(
            `[gateway] named route "${model}": classifier unavailable (deps/session); falling back to priority order`
          );
        }
        let healthyHead: NamedRouteTargetInfo | null = null;
        let healthyHop: RouteHop | null = null;
        for (const t of expandable) {
          for (const h of hopsByTarget.get(t.id)!) {
            if (await hopHealth(h)) {
              healthyHead = t;
              healthyHop = h;
              break;
            }
          }
          if (healthyHead) break;
        }
        selected = healthyHead ?? expandable[0];
        pinHop = healthyHop;
        writeBinding(selected, healthyHop ?? undefined);
      }
    }
    const head = selected ?? expandable[0];

    // 组链：链首目标的 hops 在前（pinHop 置顶），其余按 priority 接链尾
    const chain: RouteHop[] = [];
    const pushTarget = (t: NamedRouteTargetInfo) => {
      const list = [...(hopsByTarget.get(t.id) ?? [])];
      if (pinHop && t.id === head.id) {
        const idx = list.findIndex(
          (h) => h.upstream.id === pinHop!.upstream.id && h.targetModel === pinHop!.targetModel
        );
        if (idx > 0) list.unshift(list.splice(idx, 1)[0]);
      }
      chain.push(...list);
    };
    pushTarget(head);
    for (const t of expandable) if (t.id !== head.id) pushTarget(t);

    // hop 级健康重排：健康在前，degraded 排尾（相对顺序不变）
    const healthyHops: RouteHop[] = [];
    const fallbackHops: RouteHop[] = [];
    for (const hop of chain) {
      if (await hopHealth(hop)) {
        healthyHops.push(hop);
      } else {
        fallbackHops.push(hop);
      }
    }
    hops = [...healthyHops, ...fallbackHops];
  }

  // ---- 自动路由 ----
  if (!namedRoute) {
    const { candidates } = routeModelByProtocol(model, protocol, upstreams);
    if (candidates.length === 0) {
      if (routeModel(model, upstreams)) {
        return planError(
          400,
          "protocol_mismatch",
          `Protocol mismatch: model "${model}" is not configured for the ${protocol} protocol`
        );
      }
      return planError(404, "model_not_found", `No upstream configured for model: ${model}`);
    }
    // 候选去重 + 健康过滤；无健康候选时兜底（unhealthy 也尝试），不留 502
    const seen = new Set<number>();
    const allCandidates: UpstreamRoute[] = [];
    for (const candidate of candidates) {
      if (seen.has(candidate.upstream.id)) continue;
      seen.add(candidate.upstream.id);
      allCandidates.push(candidate.upstream);
    }
    for (const candidate of allCandidates) {
      const upDown = deps.health && !(await deps.health.isHealthy(candidate.id));
      const modelDown =
        deps.health?.isModelHealthy && !(await deps.health.isModelHealthy(candidate.id, model));
      if (upDown || modelDown) continue;
      hops.push({ upstream: candidate, targetModel: model });
    }
    if (hops.length === 0) {
      deps.log?.(
        `[gateway] no healthy candidates for model: ${model}; falling back to unhealthy upstreams`
      );
      hops = allCandidates.map((u) => ({ upstream: u, targetModel: model }));
    }
  }

  // 已放弃兜底的 upstream 从链中剔除（含命名路由目标链）
  if (deps.health?.isGivenUp) {
    const before = hops.length;
    hops = hops.filter((h) => !deps.health!.isGivenUp!(h.upstream.id));
    if (hops.length !== before) {
      deps.log?.(
        `[gateway] dropped ${before - hops.length} given-up upstream(s) from the attempt chain`
      );
    }
    if (hops.length === 0) {
      return planError(
        502,
        "upstream_unavailable",
        `No available upstream for model: ${model}`
      );
    }
  }

  // 自动路由的多候选 session 粘性（upstream 粒度）
  if (!namedRoute && hops.length > 1 && deps.session) {
    const binding = deps.session.getBinding(routeSessionId);
    if (binding && hops.some((h) => h.upstream.id === binding.upstreamId)) {
      const bound = hops.filter((h) => h.upstream.id === binding.upstreamId);
      const rest = hops.filter((h) => h.upstream.id !== binding.upstreamId);
      hops = [...bound, ...rest];
    }
  }

  // ---- 配额（与直连同口径：DB 用量 + 本次预留；边界「> limit 才超限」） ----
  const reservedTokens = planReservedTokens(input);
  const reservedRpm = 1;
  const violation = await checkPlanQuota(input, deps, now, reservedTokens, reservedRpm);
  if (violation) return violation;

  // ---- 展平为 (upstream, key) hop 列表 ----
  const suppressHealth: ("403" | "404")[] =
    mode === "responses-create" ? ["403", "404"] : [];
  const timeoutMs = input.stream === true ? null : PLAN_NON_STREAMING_TIMEOUT_MS;
  const planHops: PlanHop[] = [];
  for (const hop of hops) {
    const keys = await deps.resolveUpstreamKeys(hop.upstream.id);
    if (keys.length === 0) continue; // 无 key 的 upstream 不产生 hop
    const hopModel = namedRoute ? hop.targetModel : model;
    const hopPath =
      namedRoute && protocol === "gemini"
        ? pathname.replace(/^(\/v1(?:\/?beta)?\/models\/)[^/:]+/, `$1${hopModel}`)
        : pathname;
    const url = `${joinUrlPath(hop.upstream.baseUrl, hopPath)}${query}`;
    const privateNetwork = requiresPrivateNetwork(hop.upstream);
    for (const key of keys) {
      planHops.push({
        hopIndex: planHops.length,
        upstreamId: hop.upstream.id,
        keyId: key.id,
        url,
        realModel: hopModel,
        requiresPrivateNetwork: privateNetwork,
        retries: MAX_RETRY,
        continueOn: [...ROUTER_CONTINUE_ON],
        stopOn: [...ROUTER_STOP_ON],
        passthrough: "last-4xx",
        timeoutMs,
        suppressHealth: [...suppressHealth],
        skipSiblingsOn: [...SKIP_SIBLINGS_ON],
        upstreamName: hop.upstream.name,
        proxyUrl: hop.upstream.proxyUrl ?? null,
        headerTransforms: hop.upstream.headerTransforms ?? [],
      });
    }
  }
  if (planHops.length === 0) {
    return namedRoute
      ? planError(
          502,
          "named_route_unavailable",
          "Named route target unavailable: no valid upstream targets"
        )
      : planError(502, "upstream_unavailable", `No available upstream for model: ${model}`);
  }

  return {
    ok: true,
    hops: planHops,
    quota: quotaOf(reservedTokens, reservedRpm),
    sessionId,
    routeSessionId,
    recordSessionId,
  };
}

// responses 子资源（/v1/responses/{id} 及子路径）：无 model，全部 openai upstream 按 priority 遍历；
// 健康只看 upstream 级；404/403 零健康标记；恒 60s 超时；不记 usage、reservedTokens = 0。
async function buildSubresourcePlan(
  input: BuildPlanInput,
  deps: PlanDeps,
  now: number,
  ctx: { sessionId: string; routeSessionId: string; recordSessionId: string | null }
): Promise<BuildPlanResult> {
  const { virtualKey } = input;
  const { pathname, query } = splitPlanPath(input.path);
  const responseId = pathname.slice("/v1/responses/".length).split("/")[0] ?? "";
  if (responseId && deps.lookupResponseOwner) {
    const owner = await deps.lookupResponseOwner(responseId);
    if (owner !== null && owner !== virtualKey.id) {
      return planError(403, "forbidden", "Response belongs to another virtual key");
    }
  }

  const upstreams = await deps.loadUpstreams();
  const chain = upstreams
    .filter((u) => u.enabled !== false && u.protocol === "openai")
    .sort((a, b) => a.priority - b.priority);

  const healthy: UpstreamRoute[] = [];
  for (const upstream of chain) {
    if (deps.health && !(await deps.health.isHealthy(upstream.id))) {
      continue;
    }
    healthy.push(upstream);
  }
  if (healthy.length === 0) {
    const fallback = chain.filter((u) => !deps.health?.isGivenUp?.(u.id));
    deps.log?.(
      `[gateway] no healthy upstream available; falling back to ${fallback.length}/${chain.length} unhealthy upstream(s)`
    );
    healthy.push(...fallback);
    if (healthy.length === 0) {
      return planError(502, "upstream_unavailable", "No available upstream");
    }
  }

  const reservedTokens = 0;
  const reservedRpm = 1;
  const violation = await checkPlanQuota(input, deps, now, reservedTokens, reservedRpm);
  if (violation) return violation;

  // 子资源的 continueOn：401 → 换 key；429/5xx → 同 key 重试后保留响应；
  // 404/403 → 换 upstream（保留响应）；其他 4xx → 直接透传。
  // 已知偏差：展平后 404/403 会多试同 upstream 的其余 key（直连侧是跳过该 upstream 剩余 key），
  // 影响仅是多几次 404，不改变最终落点。
  const continueOn: ContinueCondition[] = [
    "401",
    "403",
    "404",
    "429",
    "5xx",
    "network",
    "timeout",
  ];
  const planHops: PlanHop[] = [];
  for (const upstream of healthy) {
    const keys = await deps.resolveUpstreamKeys(upstream.id);
    if (keys.length === 0) continue;
    const url = `${joinUrlPath(upstream.baseUrl, pathname)}${query}`;
    const privateNetwork = requiresPrivateNetwork(upstream);
    for (const key of keys) {
      planHops.push({
        hopIndex: planHops.length,
        upstreamId: upstream.id,
        keyId: key.id,
        url,
        realModel: null, // 无 model 可改写
        requiresPrivateNetwork: privateNetwork,
        retries: MAX_RETRY,
        continueOn: [...continueOn],
        stopOn: ["2xx", "4xx-other"],
        passthrough: "last-business",
        timeoutMs: PLAN_NON_STREAMING_TIMEOUT_MS,
        suppressHealth: ["403", "404"],
        skipSiblingsOn: [...SKIP_SIBLINGS_ON],
        upstreamName: upstream.name,
        proxyUrl: upstream.proxyUrl ?? null,
        headerTransforms: upstream.headerTransforms ?? [],
      });
    }
  }
  if (planHops.length === 0) {
    return planError(502, "upstream_unavailable", "No available upstream");
  }
  return {
    ok: true,
    hops: planHops,
    quota: { reservedTokens, reservedRpm },
    sessionId: ctx.sessionId,
    routeSessionId: ctx.routeSessionId,
    recordSessionId: ctx.recordSessionId,
  };
}

function splitPlanPath(path: string): { pathname: string; query: string } {
  const q = path.indexOf("?");
  const pathname = q >= 0 ? path.slice(0, q) : path;
  const rawQuery = q >= 0 ? path.slice(q) : "";
  let query = "";
  if (rawQuery) {
    try {
      // 与直连同口径：剔除 `?key=` 后按 searchParams 重新编码
      const url = new URL(`http://plan.invalid${pathname}${rawQuery}`);
      query = stripQueryKey(url);
    } catch {
      query = rawQuery;
    }
  }
  return { pathname, query };
}

// 预留 token：仅 vk 配了 token 类限额才付估算成本（与直连「只有 maxRpm 的 vk 不估算」一致）
function planReservedTokens(input: BuildPlanInput): number {
  const vk = input.virtualKey;
  const tokenLimited =
    vk.maxTpm != null || vk.maxDailyTokens != null || vk.maxMonthlyTokens != null;
  if (!tokenLimited) return 0;
  return Math.max(0, Math.floor(input.estimatedInputTokens));
}

async function checkPlanQuota(
  input: BuildPlanInput,
  deps: PlanDeps,
  now: number,
  reservedTokens: number,
  reservedRpm: number
): Promise<BuildPlanResult | null> {
  const vk = input.virtualKey;
  if (!hasQuotaLimits(vk) || !deps.quota) return null;
  const at = new Date(now);
  const usage = await deps.quota.loadUsage(vk.id, at);
  const violation = checkQuota(
    {
      virtualKeyId: vk.id,
      maxRpm: vk.maxRpm ?? null,
      maxTpm: vk.maxTpm ?? null,
      maxDailyTokens: vk.maxDailyTokens ?? null,
      maxMonthlyTokens: vk.maxMonthlyTokens ?? null,
      now: at,
    },
    {
      rpm: usage.rpm + reservedRpm,
      tpm: usage.tpm + reservedTokens,
      dailyTokens: usage.dailyTokens + reservedTokens,
      monthlyTokens: usage.monthlyTokens + reservedTokens,
    }
  );
  if (!violation) return null;
  return planError(
    429,
    "quota_exceeded",
    `Quota exceeded (${violation.dimension}: ${violation.current} / ${violation.limit})`
  );
}

// upstreams.classifier_models 原始 JSON → 分类器模型条目：直接复用 proxy.ts 同源解析器
