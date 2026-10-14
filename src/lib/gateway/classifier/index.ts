// 分类器调用入口：直连 classifier upstream（不经 handleProxyRequest，避免递归/vk 认证），
// 复用 upstream 的 key 链 / 协议认证 / proxyUrl / redirect:"manual"（与 probe 同口径的出站约束）。
import type { Protocol, UpstreamRoute } from "../model-router";
import { buildAuthHeaders } from "../upstream-client";
import { joinUrlPath } from "../url-utils";
import { getProxyDispatcher } from "../proxy-dispatcher";
import { jevSystemoneAdapter } from "./adapters/jev-systemone";
import { chatAdapter } from "./adapters/chat";
import { buildStateSummary, extractMessageTexts } from "./summarize";
import { estimateOverheadTokens } from "./types";
import { resolveInputBudget } from "./budget";
import type {
  ClassifierAdapter,
  ClassifierDecision,
  ClassifierModelEntry,
  ClassifierRouteOption,
  ClassifierType,
  ClassifierUsage,
} from "./types";

export const CLASSIFIER_TIMEOUT_MS = 10_000;
const MIN_SUMMARY_BUDGET_TOKENS = 256;

const ADAPTERS: Record<ClassifierType, ClassifierAdapter> = {
  "jev-systemone": jevSystemoneAdapter,
  chat: chatAdapter,
};

export function getClassifierAdapter(type: ClassifierType): ClassifierAdapter {
  return ADAPTERS[type];
}

export interface ClassifierRoute {
  routeId: number; // named_route_targets.id
  targetModel: string;
  description: string | null;
}

export interface RunClassifierDeps {
  resolveUpstreamKeys: (upstreamId: number) => Promise<string[]>;
  // models.dev context window 查询（可选；未提供则跳过该档预算来源）
  lookupContextWindow?: (model: string) => Promise<number | null>;
  log?: (message: string) => void;
}

export interface ClassifierRunResult {
  routeId: number | null; // null = 分类器不可用/输出非法，调用方回退 priority 最小候选
  usage: ClassifierUsage | null;
}

export async function runClassifier(opts: {
  upstream: UpstreamRoute; // classifier 所在 upstream（协议决定认证方式）
  entry: ClassifierModelEntry;
  instruction: string;
  routes: ClassifierRoute[];
  bodyJson: unknown;
  protocol: Protocol; // 业务请求协议（用于消息提取）
  deps: RunClassifierDeps;
}): Promise<ClassifierRunResult> {
  const { upstream, entry, instruction, routes, bodyJson, protocol, deps } = opts;
  const adapter = getClassifierAdapter(entry.type);

  // chat adapter 的 wire format 是 openai chat completions；classifier upstream 必须同为 openai 协议
  if (entry.type === "chat" && upstream.protocol !== "openai") {
    deps.log?.(
      `[gateway] classifier "${entry.model}" type=chat requires openai-protocol upstream "${upstream.name}" (got ${upstream.protocol})`
    );
    return { routeId: null, usage: null };
  }

  // 选项键：r<routeId>（jev criteria 键名规则安全；chat adapter 同理解析）
  const options: ClassifierRouteOption[] = routes.map((r) => ({
    key: `r${r.routeId}`,
    routeId: r.routeId,
    label: r.description ? `${r.targetModel} — ${r.description}` : r.targetModel,
  }));

  // 预算制摘要：条目配置 > models.dev context > 默认 4096；扣除固定开销后留给消息
  const modelsDevContext = deps.lookupContextWindow
    ? await deps.lookupContextWindow(entry.model).catch(() => null)
    : null;
  const budgetTokens = resolveInputBudget(entry.maxInputTokens, modelsDevContext);
  const overhead = estimateOverheadTokens(instruction, options);
  const summaryBudget = Math.max(MIN_SUMMARY_BUDGET_TOKENS, budgetTokens - overhead);
  const messages = extractMessageTexts(bodyJson, protocol);
  const state = buildStateSummary(messages, summaryBudget);

  const request = adapter.buildRequest(entry.model, { instruction, options, state }, entry);
  const url = joinUrlPath(upstream.baseUrl, request.path);
  const body = JSON.stringify(request.body);

  const keys = await deps.resolveUpstreamKeys(upstream.id);
  if (keys.length === 0) {
    deps.log?.(`[gateway] classifier upstream "${upstream.name}" has no keys; skipping decision`);
    return { routeId: null, usage: null };
  }

  for (const apiKey of keys) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), CLASSIFIER_TIMEOUT_MS);
      const dispatcher = getProxyDispatcher(upstream.proxyUrl);
      let response: Response;
      try {
        response = await fetch(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "accept-encoding": "identity",
            ...buildAuthHeaders(upstream.protocol, apiKey),
          },
          body,
          redirect: "manual", // 3xx 视为失败（防 key 跨源泄露），与主链路口径一致
          signal: controller.signal,
          ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
      } finally {
        clearTimeout(timer);
      }
      if (response.status < 200 || response.status >= 300) {
        deps.log?.(
          `[gateway] classifier request failed: status ${response.status} on upstream "${upstream.name}"`
        );
        await response.body?.cancel().catch(() => {});
        continue; // 换下一个 key
      }
      const json: unknown = await response.json().catch(() => null);
      const decision: ClassifierDecision = adapter.parseResponse(json, options);
      if (decision.routeId === null) {
        deps.log?.(`[gateway] classifier returned unparseable/unknown route option`);
      }
      return decision;
    } catch (err) {
      deps.log?.(
        `[gateway] classifier request error: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
  return { routeId: null, usage: null };
}
