// 通用 model 探活函数：非流式小 LLM 请求，不记录 token 用量。
// 用于 unhealthy upstream 的自动恢复探活与 Admin 面板的模型可用性测试。
import type { Protocol } from "./model-router";
import { buildAuthHeaders } from "./upstream-client";
import { joinUrlPath } from "./url-utils";

export interface ProbeTarget {
  protocol: Protocol;
  baseUrl: string;
}

export type ProbeStyle = "chat" | "responses";

export interface ProbeResult {
  ok: boolean;
  status: number;
  error?: string;
  style?: ProbeStyle; // 成功/失败时使用的探测风格（openai 双风格探测后标注）
}

export const PROBE_TIMEOUT_MS = 15_000;

export function buildProbeRequest(
  protocol: Protocol,
  baseUrl: string,
  model: string,
  apiStyle: ProbeStyle = "chat"
): { url: string; body: Record<string, unknown> } {
  switch (protocol) {
    case "anthropic":
      return {
        url: joinUrlPath(baseUrl, "/v1/messages"),
        body: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false },
      };
    case "gemini":
      return {
        url: joinUrlPath(baseUrl, `/v1beta/models/${model}:generateContent`),
        body: {
          contents: [{ parts: [{ text: "hi" }] }],
          generationConfig: { maxOutputTokens: 1 },
        },
      };
    default:
      if (apiStyle === "responses") {
        return {
          url: joinUrlPath(baseUrl, "/v1/responses"),
          // 不显式声明 stream: false（responses API 默认非流式；部分兼容实现
          // 会拒绝未知/冗余参数返回 5xx，反而掩盖真实的 4xx 错误信息）
          body: { model, input: "hi" },
        };
      }
      return {
        url: joinUrlPath(baseUrl, "/v1/chat/completions"),
        body: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false },
      };
  }
}

async function probeOnce(
  target: ProbeTarget,
  model: string,
  apiKey: string,
  apiStyle: ProbeStyle,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ProbeResult> {
  const { url, body } = buildProbeRequest(target.protocol, target.baseUrl, model, apiStyle);
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onOuterAbort = () => controller.abort();
  opts.signal?.addEventListener("abort", onOuterAbort);

  try {
    // 显式声明 content-type：undici 对字符串 body 默认发 text/plain，多数上游会拒绝
    const headers = new Headers(buildAuthHeaders(target.protocol, apiKey));
    headers.set("content-type", "application/json");
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (res.ok) return { ok: true, status: res.status, style: apiStyle };
    const text = await res.text();
    return { ok: false, status: res.status, error: text.slice(0, 300), style: apiStyle };
  } catch (err) {
    return {
      ok: false,
      status: 0,
      error: err instanceof Error ? err.message : String(err),
      style: apiStyle,
    };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
}

// openai 协议双风格探测：chat 基线优先（openai 兼容的定义），失败且与风格相关时
// 补发一次 responses 探测（可能是 responses-only model），任一成功即可用。
// 补发条件：任何 4xx（401 除外）或 501（未实现端点）——400/403/404/405/422/501 都可能是
// "该 upstream 不支持 chat 风格"的信号；401（key 问题）、429/其余 5xx（限流/服务端）、
// 网络错误与风格无关，不补发。健康语义：model 级健康 = 任一风格可用。
export async function probeModel(
  target: ProbeTarget,
  model: string,
  apiKey: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ProbeResult> {
  const chatResult = await probeOnce(target, model, apiKey, "chat", opts);
  if (chatResult.ok || target.protocol !== "openai") return chatResult;
  const shouldFallback =
    chatResult.status === 501 ||
    (chatResult.status >= 400 &&
      chatResult.status < 500 &&
      chatResult.status !== 401 &&
      chatResult.status !== 429);
  if (shouldFallback) {
    const responsesResult = await probeOnce(target, model, apiKey, "responses", opts);
    if (responsesResult.ok) return responsesResult;
    // 双风格均失败：返回最后一次尝试结果，error 回退 chat 的原始错误
    return { ...responsesResult, error: responsesResult.error ?? chatResult.error };
  }
  return chatResult;
}

export interface ProbeKeyResult {
  ok: boolean;
  status: number;
  error?: string;
}

export interface ProbeModelWithKeysResult {
  ok: boolean;
  status: number;
  error?: string;
  keyResults: ProbeKeyResult[];
  sawModelError: boolean; // 出现 403/404（model 级问题）
  sawAuthError: boolean; // 出现 401（key 级问题）
}

// 依次用每个 key 探测同一 model，任一 key 成功即整体成功（与真实请求的 key 链一致）
export async function probeModelWithKeys(
  target: ProbeTarget,
  model: string,
  keys: string[],
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ProbeModelWithKeysResult> {
  const keyResults: ProbeKeyResult[] = [];
  let sawModelError = false;
  let sawAuthError = false;
  let lastStatus = 0;
  let lastError: string | undefined;

  for (const key of keys) {
    const result = await probeModel(target, model, key, opts);
    keyResults.push({ ok: result.ok, status: result.status, error: result.error });
    if (result.ok) {
      return { ok: true, status: result.status, keyResults, sawModelError, sawAuthError };
    }
    lastStatus = result.status;
    lastError = result.error;
    if (result.status === 403 || result.status === 404) sawModelError = true;
    if (result.status === 401) sawAuthError = true;
  }

  return {
    ok: false,
    status: lastStatus,
    error: lastError,
    keyResults,
    sawModelError,
    sawAuthError,
  };
}
