// 通用 model 探活函数：非流式小 LLM 请求，不记录 token 用量。
// 用于 unhealthy upstream 的自动恢复探活与 Admin 面板的模型可用性测试。
import type { Protocol } from "./model-router";
import { buildAuthHeaders } from "./upstream-client";
import { joinUrlPath } from "./url-utils";

export interface ProbeTarget {
  protocol: Protocol;
  baseUrl: string;
}

export interface ProbeResult {
  ok: boolean;
  status: number;
  error?: string;
}

export const PROBE_TIMEOUT_MS = 15_000;

export function buildProbeRequest(
  protocol: Protocol,
  baseUrl: string,
  model: string
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
      return {
        url: joinUrlPath(baseUrl, "/v1/chat/completions"),
        body: { model, messages: [{ role: "user", content: "hi" }], max_tokens: 1, stream: false },
      };
  }
}

export async function probeModel(
  target: ProbeTarget,
  model: string,
  apiKey: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {}
): Promise<ProbeResult> {
  const { url, body } = buildProbeRequest(target.protocol, target.baseUrl, model);
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
    if (res.ok) return { ok: true, status: res.status };
    const text = await res.text();
    return { ok: false, status: res.status, error: text.slice(0, 300) };
  } catch (err) {
    return { ok: false, status: 0, error: err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener("abort", onOuterAbort);
  }
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
