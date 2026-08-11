import type { Protocol } from "./model-router";
import { GatewaySecretMissingError } from "./crypto";
import {
  extractRequestModel,
  routeModel,
  routeModelByProtocol,
  modelMatchesPattern,
  parseEnabledModels,
  detectRequestProtocol,
  findRoutingRule,
} from "./model-router";
import type { UpstreamRoute, ModelCandidate, RoutingRule } from "./model-router";
import { buildAuthHeaders } from "./upstream-client";
import { joinUrlPath, sanitizePathSegments } from "./url-utils";
import { buildSessionId } from "./session";
import type { SessionBinding } from "./session";
import {
  parseOpenAiNonStreaming,
  parseAnthropicNonStreaming,
  parseGeminiNonStreaming,
} from "./parsers";
import { StreamUsageExtractor } from "./parsers/stream-usage";
import type { ParsedUsage } from "./parsers/types";
import { checkQuota } from "./quota";
import type { QuotaUsage } from "./quota";
import { rewriteModelNonStreaming, createSseModelRewriter } from "./response-rewriter";

export const MAX_RETRY = 2; // 每个 key 内最多尝试次数
const NON_STREAMING_TIMEOUT_MS = 60_000;
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 流式空闲超时默认 30min（面板可调）

// 请求体上限：默认 32MB（覆盖多图 base64 场景，base64 膨胀 33%），env GATEWAY_MAX_BODY_MB 可调
const DEFAULT_MAX_REQUEST_BODY_BYTES = 32 * 1024 * 1024;
// 非流式响应整包缓冲上限：仅 usage 解析需要（流式路径 O(1) 不受影响）
const MAX_NON_STREAMING_RESPONSE_BYTES = 50 * 1024 * 1024;

export function getMaxRequestBodyBytes(): number {
  const mb = Number(process.env.GATEWAY_MAX_BODY_MB);
  return Number.isFinite(mb) && mb > 0 ? mb * 1024 * 1024 : DEFAULT_MAX_REQUEST_BODY_BYTES;
}

// 读取请求体并限制大小：超限返回 null（调用方返回 413）；
// content-length 超限直接拒绝，chunked（无 content-length）边读边计数，超限即中断
async function readRequestBody(request: Request): Promise<Uint8Array | null> {
  const maxBytes = getMaxRequestBodyBytes();
  const declared = request.headers.get("content-length");
  if (declared !== null) {
    const n = Number(declared);
    if (Number.isFinite(n) && n > maxBytes) return null;
  }
  const raw = request.body;
  if (!raw) {
    return new Uint8Array(await request.arrayBuffer());
  }
  const reader = raw.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return null;
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    throw new Error("Failed to read request body");
  }
  if (chunks.length === 0) return new Uint8Array(0);
  return concatUint8Arrays(chunks);
}

export interface VirtualKeyInfo {
  id: number;
  name: string;
  enabled: boolean;
  enabledModels?: string | string[];
  maxRpm?: number | null;
  maxTpm?: number | null;
  maxDailyTokens?: number | null;
  maxMonthlyTokens?: number | null;
}

export interface RecordUsageMeta {
  model: string;
  provider: string;
  agent: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  status?: string;
  latencyMs?: number;
  virtualKeyId?: number;
  userAgent?: string | null;
  targetModel?: string | null; // 手动路由映射后的上游真实模型名
}

export interface ProxyDeps {
  // 虚拟 key 校验：全表解密比对
  resolveVirtualKey: (token: string) => Promise<VirtualKeyInfo | null>;
  // 上游 key 链（解密后的明文，按配置顺序，已过滤禁用）
  resolveUpstreamKeys: (upstreamId: number) => Promise<string[]>;
  // 加载所有启用的上游（含 enabledModels）
  loadUpstreams: () => Promise<UpstreamRoute[]>;
  // 加载全部手动路由规则（可选；未实现则手动路由不生效）
  loadRoutingRules?: () => Promise<RoutingRule[]>;
  // usage 解析完成回调（写库）
  onUsage?: (meta: RecordUsageMeta) => Promise<void>;
  // 请求完成回调（更新 last_used_at 等）
  onComplete?: (meta: { virtualKeyId: number }) => Promise<void>;
  // 流式空闲超时（毫秒，可选；缺省 DEFAULT_STREAM_IDLE_TIMEOUT_MS）
  resolveStreamIdleTimeoutMs?: () => Promise<number>;
  // 配额用量加载（必填依赖；实现见 proxy-deps）
  quota: {
    loadUsage: (virtualKeyId: number, now: Date) => Promise<QuotaUsage>;
  };
  // 会话粘性 binding（跨 upstream failover 时保存/查询；可选，缺省则无粘性）
  session?: {
    getBinding: (sessionId: string) => SessionBinding | undefined;
    setBinding: (sessionId: string, upstreamId: number) => void;
  };
  // upstream / model 健康状态（可选，缺省视为全部健康且不标记）
  health?: {
    isHealthy: (upstreamId: number) => Promise<boolean>;
    markUnhealthy: (upstreamId: number) => Promise<void> | void;
    isModelHealthy?: (upstreamId: number, model: string) => Promise<boolean>;
    markModelUnhealthy?: (upstreamId: number, model: string) => Promise<void> | void;
  };
  log?: (message: string) => void;
}

// 从请求头/query 中提取虚拟 key token
export function extractVirtualKeyToken(
  headers: Headers,
  searchParams: URLSearchParams
): string | null {
  const authorization = headers.get("authorization");
  if (authorization && authorization.startsWith("Bearer ")) {
    const token = authorization.slice("Bearer ".length).trim();
    if (token) return token;
  }
  const apiKey = headers.get("x-api-key");
  if (apiKey) return apiKey;
  const googKey = headers.get("x-goog-api-key");
  if (googKey) return googKey;
  const queryKey = searchParams.get("key");
  if (queryKey) return queryKey;
  return null;
}

// 构造发往上游的请求头：剔除客户端认证/传输头，按协议注入真实 key
export function buildUpstreamHeaders(
  clientHeaders: Headers,
  protocol: Protocol,
  apiKey: string
): Headers {
  const headers = new Headers();
  const SKIP = new Set([
    "host",
    "authorization",
    "content-length",
    "connection",
    "keep-alive",
    "transfer-encoding",
    "proxy-authorization",
    "proxy-connection",
    "te",
    "trailer",
    "upgrade",
    "x-api-key",
    "x-goog-api-key",
    "accept-encoding", // 强制 identity，保证响应体可解析 usage
    // 客户端可控的源信息/会话头一律不透明传给上游（防伪造 IP 溯源、会话窃取）
    "x-forwarded-for",
    "x-forwarded-proto",
    "x-forwarded-host",
    "x-forwarded-port",
    "x-real-ip",
    "forwarded",
    "via",
    "cookie",
    "cf-connecting-ip",
    "true-client-ip",
    "x-client-ip",
  ]);
  clientHeaders.forEach((value, key) => {
    const lower = key.toLowerCase();
    if (SKIP.has(lower)) return;
    headers.set(key, value);
  });
  headers.set("accept-encoding", "identity");
  for (const [key, value] of Object.entries(buildAuthHeaders(protocol, apiKey))) {
    headers.set(key, value);
  }
  return headers;
}

export function isStreamingResponse(headers: Headers): boolean {
  const contentType = headers.get("content-type")?.toLowerCase() ?? "";
  return contentType.includes("text/event-stream");
}

function isRetryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// 重定向：手动模式不跟随（防上游 key 随重定向跨源泄露），3xx 一律视为失败
function isRedirectStatus(status: number): boolean {
  return status >= 300 && status < 400;
}

// 认证类错误（key 无效/无权限）：该 key 不可用，不重试，
// 尝试下一个 key；全部 key 均失败则 failover 到下一个 upstream
function isAuthStatus(status: number): boolean {
  return status === 401 || status === 403;
}

function isNonStreamingRequestBody(bodyJson: unknown): boolean {
  if (typeof bodyJson === "object" && bodyJson !== null) {
    const stream = (bodyJson as Record<string, unknown>).stream;
    if (typeof stream === "boolean") return !stream;
  }
  return false;
}

export const PROXY_RESPONSE_HEADERS: Record<string, string> = {
  "cache-control": "no-store",
  "x-accel-buffering": "no",
};

// 核心代理流程
export async function handleProxyRequest(
  request: Request,
  deps: ProxyDeps
): Promise<Response> {
  const url = new URL(request.url);
  const rawPath = url.pathname;
  // `..` 段净化：拒绝逃逸出上游 base 前缀的路径（/v1/../internal 等）
  const path = sanitizePathSegments(rawPath);
  if (path === null) {
    return proxyError(400, "Invalid request path", "invalid_request_error");
  }
  const token = extractVirtualKeyToken(request.headers, url.searchParams);

  const rawUA = request.headers.get("user-agent");
  const userAgent = rawUA && rawUA.trim() !== "" ? rawUA.slice(0, 512) : null;

  if (!token) {
    return proxyError(401, "Missing virtual key", "authentication_error");
  }

  let virtualKey;
  try {
    virtualKey = await deps.resolveVirtualKey(token);
  } catch (err) {
    if (err instanceof GatewaySecretMissingError) {
      return proxyError(503, "Gateway secret is not configured", "gateway_error");
    }
    throw err;
  }
  if (!virtualKey || !virtualKey.enabled) {
    return proxyError(401, "Invalid or revoked virtual key", "authentication_error");
  }

  // GET /v1/models：返回所有启用上游模型的并集 + 手动路由虚拟名（按请求协议过滤，均过 vk allowlist）
  if (request.method === "GET" && path.endsWith("/models")) {
    const upstreams = await deps.loadUpstreams();
    const protocol = detectRequestProtocol(path);
    const rules = deps.loadRoutingRules ? await deps.loadRoutingRules() : [];
    const manualNames = rules
      .filter((r) => r.protocol === protocol)
      .map((r) => r.name);
    const models = collectEnabledModels(upstreams, manualNames).filter((id) =>
      isModelAllowedByVirtualKey(virtualKey, id)
    );
    return Response.json(
      {
        object: "list",
        data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "gateway" })),
      },
      { headers: PROXY_RESPONSE_HEADERS }
    );
  }

  // responses 辅助端点（/v1/responses/{id} 及子路径：retrieve/cancel/update/input_items/output_items）：
  // 请求体无 model 字段，无法按 model 路由；response id 由创建它的 upstream 记忆，
  // 无状态遍历收敛（其余 upstream 必然 404/403）。纯透传：过 vk 认证、不过配额、不记录 usage。
  if (path.startsWith("/v1/responses/")) {
    return handleSubresourcePassthrough(request, { path, url, deps, virtualKey, userAgent });
  }

  if (!["POST", "PUT", "PATCH"].includes(request.method)) {
    return proxyError(405, "Method not allowed", "method_not_allowed");
  }

  const bodyBuffer = await readRequestBody(request);
  if (bodyBuffer === null) {
    return proxyError(413, "Request body exceeds size limit", "invalid_request_error");
  }
  const contentType = request.headers.get("content-type") ?? "";
  let bodyJson: unknown = null;
  if (bodyBuffer.length > 0 && contentType.includes("application/json")) {
    try {
      bodyJson = JSON.parse(new TextDecoder().decode(bodyBuffer));
    } catch {
      return proxyError(400, "Invalid JSON body", "invalid_request_error");
    }
  }

  const model = extractRequestModel(path, bodyJson);
  if (!model) {
    return proxyError(400, "Unable to determine model from request", "invalid_request_error");
  }
  // model 名长度上限：防超长 model 写入健康持久化 / 缓存 key 膨胀
  if (model.length > 256) {
    return proxyError(400, "Model name too long", "invalid_request_error");
  }

  // responses create（POST /v1/responses）：404/403 可能是"该 upstream 不支持 responses API"
  // 而非"model 不存在"，不触发 model 级健康标记（防误伤）
  const isResponsesCreate = path === "/v1/responses";

  // vk model allowlist 检查：'*' 全放行，其余按通配规则匹配
  if (!isModelAllowedByVirtualKey(virtualKey, model)) {
    return proxyError(403, `Model not allowed for this virtual key: ${model}`, "model_not_allowed");
  }

  const upstreams = await deps.loadUpstreams();
  const protocol = detectRequestProtocol(path);

  // 手动路由短路：命中即走目标 upstream 单元素 chain，先于自动路由；
  // 目标 upstream 禁用/不存在/unhealthy 或 target_model 被 model 级标记 → 502 manual_route_unavailable
  let manualRoute: { virtualName: string; targetModel: string } | null = null;
  let chain: UpstreamRoute[] = [];
  if (deps.loadRoutingRules) {
    const rules = await deps.loadRoutingRules();
    const rule = findRoutingRule(model, protocol, rules);
    if (rule) {
      const target = upstreams.find((u) => u.id === rule.upstreamId);
      if (!target) {
        return proxyError(
          502,
          `Manual route target upstream (id=${rule.upstreamId}) is disabled or does not exist`,
          "manual_route_unavailable"
        );
      }
      if (deps.health && !(await deps.health.isHealthy(target.id))) {
        return proxyError(
          502,
          `Manual route target upstream "${target.name}" is unhealthy`,
          "manual_route_unavailable"
        );
      }
      if (
        deps.health?.isModelHealthy &&
        !(await deps.health.isModelHealthy(target.id, rule.targetModel))
      ) {
        return proxyError(
          502,
          `Manual route target model "${rule.targetModel}" is unavailable on upstream "${target.name}"`,
          "manual_route_unavailable"
        );
      }
      chain = [target];
      manualRoute = { virtualName: model, targetModel: rule.targetModel };
    }
  }

  if (!manualRoute) {
    // 按协议路由：获取所有匹配候选（exact 优先，priority 升序）
    const { candidates } = routeModelByProtocol(model, protocol, upstreams);
    if (candidates.length === 0) {
      // 保留原语义：model 仅配置在其他协议的 upstream 上 → 400 protocol_mismatch
      const global = routeModel(model, upstreams);
      if (global) {
        // 不回显内部 upstream 名称与协议配置（防拓扑泄露）
        return proxyError(
          400,
          `Protocol mismatch: model "${model}" is not configured for the ${protocol} protocol`,
          "protocol_mismatch"
        );
      }
      return proxyError(404, `No upstream configured for model: ${model}`, "model_not_found");
    }

    // 候选去重（同一 upstream 可因 exact + wildcard 命中多次）+ 过滤 unhealthy（upstream 级 + model 级）
    for (const candidate of dedupeByUpstreamId(candidates)) {
      if (deps.health && !(await deps.health.isHealthy(candidate.id))) continue;
      if (deps.health?.isModelHealthy && !(await deps.health.isModelHealthy(candidate.id, model))) {
        continue;
      }
      chain.push(candidate);
    }
    if (chain.length === 0) {
      return proxyError(502, `All upstreams are unhealthy for model: ${model}`, "upstream_error");
    }
  }

  // 默认 upstream = 排序后第一个
  const defaultUpstream = chain[0];

  // 多候选时计算 session 粘性：binding 存在且仍可用（启用/协议/健康/模型匹配均已由链过滤）
  // 则把 sticky upstream 提到链首；单候选跳过 session 计算
  let sessionId: string | null = null;
  if (chain.length > 1 && deps.session) {
    sessionId = buildSessionId(bodyJson, model, virtualKey.id, protocol);
    const binding = deps.session.getBinding(sessionId);
    if (binding && chain.some((u) => u.id === binding.upstreamId)) {
      const bound = chain.filter((u) => u.id === binding.upstreamId);
      const rest = chain.filter((u) => u.id !== binding.upstreamId);
      chain = [...bound, ...rest];
    }
  }

  // 配额检查：选上游之后、转发之前；超限直接 429 不转发上游
  const now = new Date();
  const quotaUsage = await deps.quota.loadUsage(virtualKey.id, now);
  const violation = checkQuota(
    {
      virtualKeyId: virtualKey.id,
      maxRpm: virtualKey.maxRpm ?? null,
      maxTpm: virtualKey.maxTpm ?? null,
      maxDailyTokens: virtualKey.maxDailyTokens ?? null,
      maxMonthlyTokens: virtualKey.maxMonthlyTokens ?? null,
      now,
    },
    quotaUsage
  );
  if (violation) {
    return proxyError(
      429,
      `Quota exceeded (${violation.dimension}: ${violation.current} / ${violation.limit})`,
      "quota_exceeded"
    );
  }

  const startTime = Date.now();
  const isNonStreaming = isNonStreamingRequestBody(bodyJson);

  // 手动路由请求改写：OpenAI/Anthropic 改 body.model，Gemini 改 path 中模型段
  let effectivePath = path;
  let effectiveBodyBuffer = bodyBuffer;
  const effectiveModel = manualRoute ? manualRoute.targetModel : model;
  if (manualRoute) {
    if (protocol === "gemini") {
      effectivePath = path.replace(
        /^(\/v1(?:\/?beta)?\/models\/)[^/:]+/,
        `$1${manualRoute.targetModel}`
      );
    } else if (bodyJson && typeof bodyJson === "object") {
      effectiveBodyBuffer = new TextEncoder().encode(
        JSON.stringify({ ...(bodyJson as Record<string, unknown>), model: manualRoute.targetModel })
      );
    }
  }

  let lastError: { status: number; text?: string } | null = null;
  let lastResponse: Response | null = null;
  let successUpstream: UpstreamRoute | null = null;
  // 全部候选均对该 model 返回 4xx 业务错误（404/403）时，透传最后一个原始响应
  let fallbackBusinessResponse: Response | null = null;

  // 跨 upstream 故障转移链：按链序遍历 upstream，每个 upstream 内遍历 key，
  // 每个 key 内重试 MAX_RETRY 次；只在收到响应头之前允许重试/切换（流式输出开始后不可重试）
  for (const upstream of chain) {
    const keys = await deps.resolveUpstreamKeys(upstream.id);
    if (keys.length === 0) {
      lastError = { status: 0, text: `No API keys configured for upstream: ${upstream.name}` };
      continue;
    }
    const targetUrl = `${joinUrlPath(upstream.baseUrl, effectivePath)}${stripQueryKey(url)}`;

    let upstreamFailed = true;
    let modelNotFound = false;
    let saw403 = false; // 出现过 403（可能为 key 对该 model 无权限 → model 级处理）
    for (const apiKey of keys) {
      for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        let upstreamResponse: Response | null = null;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const controller = new AbortController();
          if (isNonStreaming) {
            timeoutHandle = setTimeout(() => controller.abort(), NON_STREAMING_TIMEOUT_MS);
          }

          upstreamResponse = await fetch(targetUrl, {
            method: request.method,
            headers: buildUpstreamHeaders(request.headers, protocol, apiKey),
            body: effectiveBodyBuffer.length > 0 ? effectiveBodyBuffer : null,
            duplex: "half",
            redirect: "manual",
            signal: controller.signal,
          } as RequestInit & { duplex: "half" });

          if (isRedirectStatus(upstreamResponse.status)) {
            // 手动模式：3xx 一律视为失败（LLM API 不应重定向），防认证头跨源泄露
            lastError = { status: upstreamResponse.status };
            await upstreamResponse.body?.cancel();
            break; // 尝试下一个 key
          }
          if (isRetryableStatus(upstreamResponse.status)) {
            lastError = { status: upstreamResponse.status };
            await upstreamResponse.body?.cancel();
            continue; // 重试
          }
          if (isAuthStatus(upstreamResponse.status)) {
            lastError = { status: upstreamResponse.status };
            if (upstreamResponse.status === 403) {
              // 403 可能是"key 对该 model 无权限"：保留响应（全部候选失败时透传），
              // 换下一个 key；全部 key 均 403 时按 model 级标记，不误伤其他 model
              fallbackBusinessResponse = upstreamResponse;
              saw403 = true;
            } else {
              await upstreamResponse.body?.cancel();
            }
            break; // 尝试下一个 key
          }
          if (upstreamResponse.status === 404) {
            // model 在该 upstream 不存在：标记 model 级不可用（仅此 model，不影响其他），
            // 继续尝试下一个候选 upstream；全部 404 时透传最后一个 404
            lastError = { status: 404 };
            fallbackBusinessResponse = upstreamResponse; // 不 cancel：保留透传
            modelNotFound = true;
            if (!isResponsesCreate) {
              deps.health?.markModelUnhealthy?.(upstream.id, effectiveModel);
              deps.log?.(
                `[gateway] model "${effectiveModel}" marked unavailable on upstream "${upstream.name}" (404)`
              );
            }
            break;
          }
          lastResponse = upstreamResponse; // 成功（含其他 4xx 业务错误）：直接透传
          successUpstream = upstream;
          upstreamFailed = false;
          break;
        } catch (err) {
          lastError = {
            status: 0,
            text: err instanceof Error ? err.message : String(err),
          };
          // 网络错误/超时 → 重试
        } finally {
          clearTimeout(timeoutHandle);
        }

        if (lastResponse) break;
      }
      if (lastResponse || modelNotFound) break;
    }

    if (lastResponse) {
      // 后续候选成功：释放未透传的业务错误 body，避免连接泄漏
      await fallbackBusinessResponse?.body?.cancel().catch(() => {});
      fallbackBusinessResponse = null;
      break;
    }
    if (modelNotFound) continue; // model 级不可用：不标记 upstream unhealthy，继续下一个
    // 该 upstream 全部 key 均失败 → 标记 unhealthy，继续下一个 upstream
    if (upstreamFailed) {
      if (saw403 && !isResponsesCreate) {
        // 全部 key 均 403：大概率是该 key 对该 model 无权限 → model 级标记，不误伤其他 model
        // （responses create 除外：403 可能是"不支持 responses"而非 key 权限问题）
        deps.health?.markModelUnhealthy?.(upstream.id, effectiveModel);
        deps.log?.(
          `[gateway] model "${effectiveModel}" marked unavailable on upstream "${upstream.name}" (403 on all keys)`
        );
      } else if (!saw403) {
        deps.health?.markUnhealthy(upstream.id);
        deps.log?.(
          `[gateway] upstream "${upstream.name}" marked unhealthy after all keys failed`
        );
      }
    }
  }

  // 全部失败：优先透传最后一个业务错误响应（404/403），其余返回 502
  if (!lastResponse) {
    deps.onComplete?.({ virtualKeyId: virtualKey.id }).catch(() => {});
    if (fallbackBusinessResponse) {
      const meta: RecordUsageMeta = {
        model,
        provider: defaultUpstream.name,
        agent: virtualKey.name,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        virtualKeyId: virtualKey.id,
        userAgent,
        targetModel: manualRoute ? manualRoute.targetModel : null,
      };
      return passthroughResponse(fallbackBusinessResponse, {
        meta,
        deps,
        bodyJson,
        protocol,
        virtualKeyId: virtualKey.id,
        virtualModelName: manualRoute?.virtualName,
      });
    }
    if (manualRoute) {
      // 手动路由不做跨 upstream fallback：目标 upstream 无 key / 全部 key 失败 → 502。
      // 不回显 lastError.text（可能含内网地址等内部细节），仅日志保留
      if (lastError?.text) {
        deps.log?.(`[gateway] manual route failed: ${lastError.text}`);
      }
      const detail =
        lastError && lastError.status > 0
          ? `upstream returned status ${lastError.status}`
          : "upstream request failed";
      return proxyError(502, `Manual route target unavailable: ${detail}`, "manual_route_unavailable");
    }
    if (lastError && lastError.status > 0) {
      return new Response(
        JSON.stringify({
          error: { message: `Upstream returned status ${lastError.status}`, type: "upstream_error" },
        }),
        { status: 502, headers: PROXY_RESPONSE_HEADERS }
      );
    }
    if (lastError?.text) {
      deps.log?.(`[gateway] upstream request failed: ${lastError.text}`);
    }
    return proxyError(502, "Upstream request failed", "upstream_error");
  }

  // 成功落点不是默认 upstream 时保存 session binding（粘性绑定）；仅 2xx 落点生效
  if (
    sessionId &&
    deps.session &&
    lastResponse.status >= 200 &&
    lastResponse.status < 300 &&
    successUpstream &&
    successUpstream.id !== defaultUpstream.id
  ) {
    deps.session.setBinding(sessionId, successUpstream.id);
  }

  const latencyMs = Date.now() - startTime;
  const meta: RecordUsageMeta = {
    model,
    provider: (successUpstream ?? defaultUpstream).name,
    agent: virtualKey.name,
    inputTokens: 0,
    outputTokens: 0,
    cacheRead: 0,
    cacheWrite: 0,
    latencyMs,
    virtualKeyId: virtualKey.id,
    userAgent,
    targetModel: manualRoute ? manualRoute.targetModel : null,
  };

  return passthroughResponse(lastResponse, {
    meta,
    deps,
    bodyJson,
    protocol,
    virtualKeyId: virtualKey.id,
    virtualModelName: manualRoute?.virtualName,
  });
}

// responses 辅助端点（/v1/responses/{id} 及子路径）纯透传：
// 无 model 可路由，response id 由创建它的 upstream 记忆（provider 侧有状态），
// 其余 upstream 对该 id 必然 404/403 → 按 priority 遍历全部 openai healthy upstream 收敛到创建者。
// 404/403 不标记任何 health（id 每次不同，标记会污染）；不解析 usage（retrieve 重复调用会重复统计）、
// 不过配额（无 model 归属维度）；仍过 vk 认证（由调用方保证）。
async function handleSubresourcePassthrough(
  request: Request,
  opts: {
    path: string;
    url: URL;
    deps: ProxyDeps;
    virtualKey: VirtualKeyInfo;
    userAgent: string | null;
  }
): Promise<Response> {
  const { path, url, deps, virtualKey, userAgent } = opts;

  const upstreams = await deps.loadUpstreams();
  const chain = upstreams
    .filter((u) => u.enabled !== false && u.protocol === "openai")
    .sort((a, b) => a.priority - b.priority);

  // 健康过滤（仅 upstream 级；不过 model 级——response 记忆与 model 健康无关）
  const healthy: UpstreamRoute[] = [];
  for (const upstream of chain) {
    if (deps.health && !(await deps.health.isHealthy(upstream.id))) continue;
    healthy.push(upstream);
  }
  if (healthy.length === 0) {
    return proxyError(502, "No healthy upstream available", "upstream_error");
  }

  // 配额检查：subresource 无 model 维度，按 vk 聚合限额（RPM/TPM/Daily/Monthly）检查
  if (deps.quota) {
    const now = new Date();
    const quotaUsage = await deps.quota.loadUsage(virtualKey.id, now);
    const violation = checkQuota(
      {
        virtualKeyId: virtualKey.id,
        maxRpm: virtualKey.maxRpm ?? null,
        maxTpm: virtualKey.maxTpm ?? null,
        maxDailyTokens: virtualKey.maxDailyTokens ?? null,
        maxMonthlyTokens: virtualKey.maxMonthlyTokens ?? null,
        now,
      },
      quotaUsage
    );
    if (violation) {
      return proxyError(
        429,
        `Quota exceeded (${violation.dimension}: ${violation.current} / ${violation.limit})`,
        "quota_exceeded"
      );
    }
  }

  const bodyBuffer = await readRequestBody(request);
  if (bodyBuffer === null) {
    return proxyError(413, "Request body exceeds size limit", "invalid_request_error");
  }
  let lastError: { status: number; text?: string } | null = null;
  let fallbackBusinessResponse: Response | null = null;

  for (const upstream of healthy) {
    const keys = await deps.resolveUpstreamKeys(upstream.id);
    if (keys.length === 0) {
      lastError = { status: 0, text: `No API keys configured for upstream: ${upstream.name}` };
      continue;
    }
    const targetUrl = `${joinUrlPath(upstream.baseUrl, path)}${stripQueryKey(url)}`;

    let lastResponse: Response | null = null;
    let upstreamFailed = true;
    for (const apiKey of keys) {
      for (let attempt = 0; attempt < MAX_RETRY; attempt++) {
        let upstreamResponse: Response | null = null;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        try {
          const controller = new AbortController();
          timeoutHandle = setTimeout(() => controller.abort(), NON_STREAMING_TIMEOUT_MS);

          upstreamResponse = await fetch(targetUrl, {
            method: request.method,
            headers: buildUpstreamHeaders(request.headers, "openai", apiKey),
            body: bodyBuffer.length > 0 ? bodyBuffer : null,
            duplex: "half",
            redirect: "manual",
            signal: controller.signal,
          } as RequestInit & { duplex: "half" });

          if (isRedirectStatus(upstreamResponse.status)) {
            // 手动模式：3xx 一律视为失败（LLM API 不应重定向），防认证头跨源泄露
            lastError = { status: upstreamResponse.status };
            await upstreamResponse.body?.cancel();
            break; // 尝试下一个 key
          }
          if (isRetryableStatus(upstreamResponse.status)) {
            lastError = { status: upstreamResponse.status };
            // 保留 5xx/429 响应用于全部失败时透传：客户端可见真实状态码与错误体
            fallbackBusinessResponse = upstreamResponse;
            continue; // 重试
          }
          if (upstreamResponse.status === 401) {
            lastError = { status: 401 };
            await upstreamResponse.body?.cancel();
            break; // key 无效：换下一个 key
          }
          if (upstreamResponse.status === 404 || upstreamResponse.status === 403) {
            // 该 upstream 不认识此 response id（非创建者）：保留业务响应，换下一个 upstream，
            // 不标记 health（response id 每次不同，标记会污染 model/upstream 健康状态）
            lastError = { status: upstreamResponse.status };
            fallbackBusinessResponse = upstreamResponse;
            upstreamFailed = false;
            break;
          }
          lastResponse = upstreamResponse; // 成功（含其他 4xx 业务错误）：直接透传
          upstreamFailed = false;
          break;
        } catch (err) {
          lastError = {
            status: 0,
            text: err instanceof Error ? err.message : String(err),
          };
          // 网络错误/超时 → 重试
        } finally {
          clearTimeout(timeoutHandle);
        }

        if (lastResponse) break;
      }
      if (lastResponse || !upstreamFailed) break;
    }

    if (lastResponse) {
      // 成功：释放未透传的业务错误 body，避免连接泄漏
      await fallbackBusinessResponse?.body?.cancel().catch(() => {});
      fallbackBusinessResponse = null;
      deps.onComplete?.({ virtualKeyId: virtualKey.id }).catch(() => {});
      return passthroughResponse(lastResponse, {
        meta: {
          model: path,
          provider: upstream.name,
          agent: virtualKey.name,
          inputTokens: 0,
          outputTokens: 0,
          cacheRead: 0,
          cacheWrite: 0,
          virtualKeyId: virtualKey.id,
          userAgent,
        },
        deps,
        bodyJson: null,
        protocol: "openai",
        virtualKeyId: virtualKey.id,
        recordUsage: false, // 辅助端点不记录 usage（retrieve 重复调用会重复统计）
      });
    }

    // 全部 key 均 401/网络失败：照常标记 unhealthy（key 级真实问题，与主链路一致）
    if (upstreamFailed) {
      deps.health?.markUnhealthy(upstream.id);
      deps.log?.(
        `[gateway] upstream "${upstream.name}" marked unhealthy during responses subresource request`
      );
    }
  }

  // 全部 upstream 均未命中：优先透传最后一个业务响应（404/403）
  deps.onComplete?.({ virtualKeyId: virtualKey.id }).catch(() => {});
  if (fallbackBusinessResponse) {
    return passthroughResponse(fallbackBusinessResponse, {
      meta: {
        model: path,
        provider: healthy[0]?.name ?? "unknown",
        agent: virtualKey.name,
        inputTokens: 0,
        outputTokens: 0,
        cacheRead: 0,
        cacheWrite: 0,
        virtualKeyId: virtualKey.id,
        userAgent,
      },
      deps,
      bodyJson: null,
      protocol: "openai",
      virtualKeyId: virtualKey.id,
      recordUsage: false,
    });
  }
  if (lastError && lastError.status > 0) {
    return new Response(
      JSON.stringify({
        error: { message: `Upstream returned status ${lastError.status}`, type: "upstream_error" },
      }),
      { status: 502, headers: PROXY_RESPONSE_HEADERS }
    );
  }
  if (lastError?.text) {
    deps.log?.(`[gateway] upstream request failed: ${lastError.text}`);
  }
  return proxyError(502, "Upstream request failed", "upstream_error");
}

// 透传上游响应（单 reader，边透传边累积副本），usage 解析与写库由 deps 完成；
// 仅手动路由命中时启用响应 model 回写（virtualModelName），正常流量零开销
async function passthroughResponse(
  upstreamResponse: Response,
  opts: {
    meta: RecordUsageMeta;
    deps: ProxyDeps;
    bodyJson: unknown;
    protocol: Protocol;
    virtualKeyId: number;
    virtualModelName?: string;
    recordUsage?: boolean; // 辅助端点等场景跳过 usage 解析与写库（默认 true）
  }
): Promise<Response> {
  const { meta, deps, bodyJson, protocol, virtualKeyId, virtualModelName, recordUsage = true } = opts;
  const headers = new Headers(PROXY_RESPONSE_HEADERS);
  copyHeader(upstreamResponse.headers, headers, "content-type");
  copyHeader(upstreamResponse.headers, headers, "x-ratelimit-remaining-requests");
  copyHeader(upstreamResponse.headers, headers, "x-ratelimit-remaining-tokens");

  if (!upstreamResponse.body) {
    deps.onComplete?.({ virtualKeyId }).catch(() => {});
    return new Response(null, { status: upstreamResponse.status, headers });
  }

  const isStreaming = isStreamingResponse(upstreamResponse.headers);
  const isSuccess = upstreamResponse.status >= 200 && upstreamResponse.status < 300;
  const reader = upstreamResponse.body.getReader();
  const chunks: Uint8Array[] = [];
  // 流式响应：增量解析 usage，不持有完整响应体（内存 O(1)）
  const extractor = isStreaming ? new StreamUsageExtractor(protocol) : null;
  let onDone: () => void = () => {};

  const rewriter = virtualModelName
    ? createSseModelRewriter(protocol, virtualModelName)
    : null;

  const passthrough = new ReadableStream<Uint8Array>({
    start(controller) {
      const pump = async () => {
        let idleTimeoutMs = DEFAULT_STREAM_IDLE_TIMEOUT_MS;
        try {
          idleTimeoutMs =
            (await deps.resolveStreamIdleTimeoutMs?.()) ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS;
        } catch {
          // 解析失败保持默认
        }
        // 每次 read 前重置空闲计时器：超时未收到任何数据则中断流（防卡死连接长期占用）
        const readWithIdleTimeout = () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          return Promise.race([
            reader.read(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(
                () => reject(new Error(`stream idle timeout after ${idleTimeoutMs}ms`)),
                idleTimeoutMs
              );
            }),
          ]).finally(() => clearTimeout(timer));
        };
        try {
          if (!isStreaming && rewriter) {
            // 非流式回写：先攒完整 body → 一次性改写 → 再 enqueue（改写失败回退原始 body）
            let totalBytes = 0;
            while (true) {
              const { done, value } = await reader.read();
              if (done) break;
              totalBytes += value.length;
              if (totalBytes > MAX_NON_STREAMING_RESPONSE_BYTES) {
                throw new Error("Upstream response exceeds size limit");
              }
              chunks.push(value);
            }
            const fullText = new TextDecoder().decode(concatUint8Arrays(chunks));
            const rewritten = rewriteModelNonStreaming(fullText, protocol, virtualModelName!);
            const bytes = new TextEncoder().encode(rewritten);
            if (bytes.length > 0) controller.enqueue(bytes);
            controller.close();
          } else {
            let totalBytes = 0;
            while (true) {
              const { done, value } = await (isStreaming
                ? readWithIdleTimeout()
                : reader.read());
              if (done) break;
              if (isStreaming) {
                // feed 原始 chunk（rewriter 改写不影响 usage 提取）
                extractor!.feed(value);
              } else {
                totalBytes += value.length;
                if (totalBytes > MAX_NON_STREAMING_RESPONSE_BYTES) {
                  throw new Error("Upstream response exceeds size limit");
                }
                chunks.push(value);
              }
              controller.enqueue(rewriter ? rewriter.transform(value) : value);
            }
            if (rewriter) {
              // 流结束 flush 残余缓冲（未凑成完整事件的部分原样输出）
              const rest = rewriter.flush();
              if (rest.length > 0) controller.enqueue(rest);
            }
            controller.close();
          }
        } catch (err) {
          // 释放上游连接，避免超时/异常后连接泄漏
          await reader.cancel().catch(() => {});
          controller.error(err);
        }
      };
      pump().finally(() => onDone());
    },
    cancel() {
      reader.cancel();
    },
  });

  onDone = async () => {
    try {
      if (isSuccess && recordUsage) {
        const parsed =
          isStreaming && extractor
            ? extractor.finish()
            : parseUsageNonStreaming(
                new TextDecoder().decode(concatUint8Arrays(chunks)),
                protocol
              );
        const usage = toRecordUsage(parsed, meta);
        await deps.onUsage?.(usage);
      }
    } catch (err) {
      deps.log?.(`[gateway] usage capture failed: ${(err as Error).message}`);
    } finally {
      deps.onComplete?.({ virtualKeyId }).catch(() => {});
    }
  };

  return new Response(passthrough, { status: upstreamResponse.status, headers });
}

// vk model allowlist 匹配：'*' 全放行，空配置视为不允许（deny by default）
export function isModelAllowedByVirtualKey(
  vk: VirtualKeyInfo,
  model: string
): boolean {
  const patterns = parseEnabledModels(vk.enabledModels);
  if (patterns.includes("*")) return true;
  return patterns.some((p) => modelMatchesPattern(p, model));
}

// ---- usage 解析（按上游协议选择解析器） ----

function parseUsageNonStreaming(fullText: string, protocol: Protocol): ParsedUsage | null {
  let json: unknown;
  try {
    json = JSON.parse(fullText);
  } catch {
    return null;
  }
  switch (protocol) {
    case "anthropic":
      return parseAnthropicNonStreaming(json);
    case "gemini":
      return parseGeminiNonStreaming(json);
    default:
      return parseOpenAiNonStreaming(json);
  }
}

function toRecordUsage(parsed: ParsedUsage | null, meta: RecordUsageMeta): RecordUsageMeta {
  if (!parsed) {
    return { ...meta, inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheWrite: 0, status: "no_usage" };
  }
  return { ...meta, ...parsed };
}

// ---- 工具 ----

// 候选按 upstream 去重（同一 upstream 可因 exact + wildcard 命中多次），保留首次出现顺序
function dedupeByUpstreamId(candidates: ModelCandidate[]): UpstreamRoute[] {
  const seen = new Set<number>();
  const result: UpstreamRoute[] = [];
  for (const candidate of candidates) {
    if (seen.has(candidate.upstream.id)) continue;
    seen.add(candidate.upstream.id);
    result.push(candidate.upstream);
  }
  return result;
}

function stripQueryKey(url: URL): string {
  url.searchParams.delete("key");
  const qs = url.searchParams.toString();
  return qs ? `?${qs}` : "";
}

function collectEnabledModels(upstreams: UpstreamRoute[], manualNames: string[] = []): string[] {
  const result = new Set<string>(manualNames);
  for (const upstream of upstreams) {
    if (upstream.enabled === false) continue;
    const raw = upstream.enabledModels;
    if (Array.isArray(raw)) {
      for (const m of raw) {
        if (!m.endsWith("*")) result.add(m);
      }
    } else if (typeof raw === "string") {
      try {
        const parsed = JSON.parse(raw) as string[];
        for (const m of parsed) {
          if (!m.endsWith("*")) result.add(m);
        }
      } catch {
        // ignore
      }
    }
  }
  return Array.from(result).sort();
}

function concatUint8Arrays(chunks: Uint8Array[]): Uint8Array {
  const total = chunks.reduce((acc, c) => acc + c.length, 0);
  const result = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.length;
  }
  return result;
}

function copyHeader(from: Headers, to: Headers, name: string): void {
  const value = from.get(name);
  if (value) to.set(name, value);
}

export function proxyError(status: number, message: string, type: string): Response {
  return new Response(
    JSON.stringify({ error: { message, type } }),
    { status, headers: PROXY_RESPONSE_HEADERS }
  );
}
