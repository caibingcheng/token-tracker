import type { Protocol } from "./model-router";
import { joinUrlPath } from "./url-utils";

export interface UpstreamInfo {
  id?: number;
  protocol: Protocol;
  baseUrl: string;
}

function buildListModelsUrl(protocol: Protocol, baseUrl: string): string {
  switch (protocol) {
    case "anthropic":
      return joinUrlPath(baseUrl, "/v1/models");
    case "gemini":
      return joinUrlPath(baseUrl, "/v1beta/models");
    default:
      return joinUrlPath(baseUrl, "/models");
  }
}

export function buildAuthHeaders(
  protocol: Protocol,
  apiKey: string
): Record<string, string> {
  switch (protocol) {
    case "anthropic":
      return { "x-api-key": apiKey, "anthropic-version": "2023-06-01" };
    case "gemini":
      return { "x-goog-api-key": apiKey };
    default:
      return { Authorization: `Bearer ${apiKey}` };
  }
}

export interface ListModelsResult {
  models: string[];
  status: number;
  error?: string;
}

export async function fetchUpstreamModels(
  upstream: UpstreamInfo,
  apiKey: string,
  signal?: AbortSignal
): Promise<ListModelsResult> {
  const url = buildListModelsUrl(upstream.protocol, upstream.baseUrl);
  try {
    const res = await fetch(url, {
      headers: buildAuthHeaders(upstream.protocol, apiKey),
      signal,
    });
    const text = await res.text();
    if (!res.ok) {
      return { models: [], status: res.status, error: text.slice(0, 300) };
    }
    let json: unknown = null;
    try {
      json = JSON.parse(text);
    } catch {
      return { models: [], status: res.status, error: "Invalid JSON response" };
    }
    const models = extractModelIds(upstream.protocol, json);
    return { models, status: res.status };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { models: [], status: 0, error: message };
  }
}

function extractModelIds(protocol: Protocol, json: unknown): string[] {
  const obj = json as Record<string, unknown>;
  if (!obj) return [];
  if (Array.isArray(obj.data)) {
    return obj.data
      .map((m) => (m as Record<string, unknown>).id)
      .filter((id): id is string => typeof id === "string");
  }
  if (Array.isArray(obj.models)) {
    if (protocol === "gemini") {
      return obj.models
        .map((m) => {
          const name = (m as Record<string, unknown>).name as string | undefined;
          return name?.startsWith("models/") ? name.slice("models/".length) : name;
        })
        .filter((id): id is string => typeof id === "string");
    }
    return obj.models
      .map((m) => (m as Record<string, unknown>).name)
      .filter((id): id is string => typeof id === "string");
  }
  return [];
}

export async function testUpstreamConnection(
  upstream: UpstreamInfo,
  apiKey: string
): Promise<{ ok: boolean; status: number; error?: string; models?: string[] }> {
  const result = await fetchUpstreamModels(upstream, apiKey);
  if (!result.error) {
    return { ok: true, status: result.status, models: result.models };
  }
  return { ok: false, status: result.status, error: result.error };
}
