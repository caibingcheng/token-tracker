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
