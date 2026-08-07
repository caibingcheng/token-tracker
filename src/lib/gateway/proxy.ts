import type { Protocol } from "./model-router";
import {
  extractRequestModel,
  routeModel,
  routeModelByProtocol,
  modelMatchesPattern,
  parseEnabledModels,
  detectRequestProtocol,
} from "./model-router";
import type { UpstreamRoute, ModelCandidate } from "./model-router";
import { buildAuthHeaders } from "./upstream-client";
import { joinUrlPath } from "./url-utils";
import { buildSessionId } from "./session";
import type { SessionBinding } from "./session";
import {
  parseOpenAiNonStreaming,
  parseOpenAiStreaming,
  parseAnthropicNonStreaming,
  parseAnthropicStreaming,
  parseGeminiNonStreaming,
  parseGeminiStreaming,
} from "./parsers";
import type { ParsedUsage } from "./parsers/types";
import { checkQuota } from "./quota";
import type { QuotaUsage } from "./quota";

export const MAX_RETRY = 2; // 每个 key 内最多尝试次数
const NON_STREAMING_TIMEOUT_MS = 60_000;

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
}

export interface ProxyDeps {
  // 虚拟 key 校验：全表解密比对
  resolveVirtualKey: (token: string) => Promise<VirtualKeyInfo | null>;
  // 上游 key 链（解密后的明文，按配置顺序，已过滤禁用）
  resolveUpstreamKeys: (upstreamId: number) => Promise<string[]>;
  // 加载所有启用的上游（含 enabledModels）
  loadUpstreams: () => Promise<UpstreamRoute[]>;
  // usage 解析完成回调（写库）
  onUsage?: (meta: RecordUsageMeta) => Promise<void>;
  // 请求完成回调（更新 last_used_at 等）
  onComplete?: (meta: { virtualKeyId: number }) => Promise<void>;
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
  const path = url.pathname;
  const token = extractVirtualKeyToken(request.headers, url.searchParams);

  const rawUA = request.headers.get("user-agent");
  const userAgent = rawUA && rawUA.trim() !== "" ? rawUA.slice(0, 512) : null;

  if (!token) {
    return proxyError(401, "Missing virtual key", "authentication_error");
  }

  const virtualKey = await deps.resolveVirtualKey(token);
  if (!virtualKey || !virtualKey.enabled) {
    return proxyError(401, "Invalid or revoked virtual key", "authentication_error");
  }

  // GET /v1/models：返回所有启用上游模型的并集（按 vk enabledModels 过滤）
  if (request.method === "GET" && path.endsWith("/models")) {
    const upstreams = await deps.loadUpstreams();
    const models = collectEnabledModels(upstreams).filter((id) =>
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

  if (!["POST", "PUT", "PATCH"].includes(request.method)) {
    return proxyError(405, "Method not allowed", "method_not_allowed");
  }

  const bodyBuffer = new Uint8Array(await request.arrayBuffer());
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

  // vk model allowlist 检查：'*' 全放行，其余按通配规则匹配
  if (!isModelAllowedByVirtualKey(virtualKey, model)) {
    return proxyError(403, `Model not allowed for this virtual key: ${model}`, "model_not_allowed");
  }

  const upstreams = await deps.loadUpstreams();
  const protocol = detectRequestProtocol(path);

  // 按协议路由：获取所有匹配候选（exact 优先，priority 升序）
  const { candidates } = routeModelByProtocol(model, protocol, upstreams);
  if (candidates.length === 0) {
    // 保留原语义：model 仅配置在其他协议的 upstream 上 → 400 protocol_mismatch
    const global = routeModel(model, upstreams);
    if (global) {
      return proxyError(
        400,
        `Protocol mismatch: request path ${path} is ${protocol}, but upstream "${global.upstream.name}" is configured as ${global.upstream.protocol}`,
        "protocol_mismatch"
      );
    }
    return proxyError(404, `No upstream configured for model: ${model}`, "model_not_found");
  }

  // 候选去重（同一 upstream 可因 exact + wildcard 命中多次）+ 过滤 unhealthy（upstream 级 + model 级）
  let chain: UpstreamRoute[] = [];
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
    const targetUrl = `${joinUrlPath(upstream.baseUrl, path)}${stripQueryKey(url)}`;

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
            body: bodyBuffer.length > 0 ? bodyBuffer : null,
            duplex: "half",
            redirect: "follow",
            signal: controller.signal,
          } as RequestInit & { duplex: "half" });

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
            deps.health?.markModelUnhealthy?.(upstream.id, model);
            deps.log?.(
              `[gateway] model "${model}" marked unavailable on upstream "${upstream.name}" (404)`
            );            break;
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
      if (saw403) {
        // 全部 key 均 403：大概率是该 key 对该 model 无权限 → model 级标记，不误伤其他 model
        deps.health?.markModelUnhealthy?.(upstream.id, model);
        deps.log?.(
          `[gateway] model "${model}" marked unavailable on upstream "${upstream.name}" (403 on all keys)`
        );
      } else {
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
      };
      return passthroughResponse(fallbackBusinessResponse, {
        meta,
        deps,
        bodyJson,
        protocol,
        virtualKeyId: virtualKey.id,
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
    return proxyError(502, lastError?.text ?? "Upstream request failed", "upstream_error");
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
  };

  return passthroughResponse(lastResponse, {
    meta,
    deps,
    bodyJson,
    protocol,
    virtualKeyId: virtualKey.id,
  });
}

// 透传上游响应（单 reader，边透传边累积副本），usage 解析与写库由 deps 完成
async function passthroughResponse(
  upstreamResponse: Response,
  opts: {
    meta: RecordUsageMeta;
    deps: ProxyDeps;
    bodyJson: unknown;
    protocol: Protocol;
    virtualKeyId: number;
  }
): Promise<Response> {
  const { meta, deps, bodyJson, protocol, virtualKeyId } = opts;
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
  let onDone: () => void = () => {};

  const passthrough = new ReadableStream<Uint8Array>({
    start(controller) {
      const pump = async () => {
        try {
          while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            controller.enqueue(value);
          }
          controller.close();
        } catch (err) {
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
      if (isSuccess) {
        const fullText = new TextDecoder().decode(concatUint8Arrays(chunks));
        const parsed = isStreaming
          ? parseUsageStreaming(fullText, protocol)
          : parseUsageNonStreaming(fullText, protocol);
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

function parseUsageStreaming(sseText: string, protocol: Protocol): ParsedUsage | null {
  switch (protocol) {
    case "anthropic":
      return parseAnthropicStreaming(sseText);
    case "gemini":
      return parseGeminiStreaming(sseText);
    default:
      return parseOpenAiStreaming(sseText);
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

function collectEnabledModels(upstreams: UpstreamRoute[]): string[] {
  const result = new Set<string>();
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
