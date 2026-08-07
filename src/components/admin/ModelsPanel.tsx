"use client";

import { useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import {
  detectRequestProtocol,
  routeModelByProtocol,
  type Protocol,
  type UpstreamRoute,
} from "@/lib/gateway/model-router";
import { CopyableCode } from "./CopyableCode";

interface UpstreamSummary {
  id: number;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  priority: number;
  enabled: boolean;
  enabledModels: string[];
}

interface CandidateInfo {
  upstreamId: number;
  name: string;
  priority: number;
  matchedPattern: string;
  matchType: "exact" | "wildcard";
}

interface ResolvedRoute {
  protocol: Protocol;
  model: string;
  winner: CandidateInfo | null;
  candidates: CandidateInfo[];
}

interface WildcardInfo {
  pattern: string;
  upstreamId: number;
  name: string;
  priority: number;
}

interface ModelsData {
  upstreams: UpstreamSummary[];
  protocols: Protocol[];
  resolvedRoutes: ResolvedRoute[];
  wildcardPatternsByProtocol: Record<Protocol, WildcardInfo[]>;
}

function toUpstreamRoute(u: UpstreamSummary): UpstreamRoute {
  return {
    id: u.id,
    name: u.name,
    protocol: u.protocol,
    baseUrl: u.baseUrl,
    priority: u.priority,
    enabled: u.enabled,
    enabledModels: u.enabledModels,
  };
}

const DEFAULT_PATH = "/v1/chat/completions";

function protocolBadgeClass(protocol: Protocol): string {
  switch (protocol) {
    case "openai":
      return "bg-green-50 text-green-700 border-green-200";
    case "anthropic":
      return "bg-amber-50 text-amber-700 border-amber-200";
    case "gemini":
      return "bg-blue-50 text-blue-700 border-blue-200";
    default:
      return "bg-gray-50 text-gray-700 border-gray-200";
  }
}

function MatchTypeBadge({ type }: { type: "exact" | "wildcard" }) {
  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[10px] ${
        type === "exact" ? "bg-green-50 text-green-700" : "bg-purple-50 text-purple-700"
      }`}
    >
      {type}
    </span>
  );
}

export default function ModelsPanel() {
  const [data, setData] = useState<ModelsData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [modelInput, setModelInput] = useState("");
  const [pathInput, setPathInput] = useState(DEFAULT_PATH);
  const [simulatorResult, setSimulatorResult] = useState<{
    protocol: Protocol;
    model: string;
    winner: CandidateInfo | null;
    candidates: CandidateInfo[];
  } | null>(null);

  const [selectedProtocol, setSelectedProtocol] = useState<Protocol>("openai");
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/models");
      const json = await res.json();
      if (json.success) {
        setData(json.data);
      } else {
        setError(json.error || "Failed to load models");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const upstreamRoutes = useMemo(
    () => (data ? data.upstreams.filter((u) => u.enabled).map(toUpstreamRoute) : []),
    [data]
  );

  const runSimulation = () => {
    const model = modelInput.trim();
    const path = pathInput.trim() || DEFAULT_PATH;
    if (!model || !data) return;
    const protocol = detectRequestProtocol(path);
    const { winner, candidates } = routeModelByProtocol(model, protocol, upstreamRoutes);
    setSimulatorResult({
      protocol,
      model,
      winner: winner
        ? {
            upstreamId: winner.upstream.id,
            name: winner.upstream.name,
            priority: winner.upstream.priority,
            matchedPattern: winner.matchedPattern,
            matchType: winner.matchType,
          }
        : null,
      candidates: candidates.map((c) => ({
        upstreamId: c.upstream.id,
        name: c.upstream.name,
        priority: c.upstream.priority,
        matchedPattern: c.matchedPattern,
        matchType: c.matchType,
      })),
    });
  };

  const toggleExpanded = (key: string) => {
    setExpandedModels((prev) => {
      const next = new Set(prev);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      return next;
    });
  };

  const routesForProtocol = useMemo(() => {
    if (!data) return [];
    return data.resolvedRoutes.filter((r) => r.protocol === selectedProtocol);
  }, [data, selectedProtocol]);

  const wildcardPatterns = useMemo(() => {
    return data?.wildcardPatternsByProtocol[selectedProtocol] ?? [];
  }, [data, selectedProtocol]);

  if (loading) {
    return (
      <div className="h-40 flex items-center justify-center text-gray-400">Loading...</div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}

      {/* 匹配模拟器 */}
      <div className="rounded-lg bg-white p-4 shadow">
        <h2 className="mb-3 text-base font-semibold">Match Simulator</h2>
        <div className="grid grid-cols-1 md:grid-cols-[1fr_1fr_auto] gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Model</label>
            <input
              value={modelInput}
              onChange={(e) => setModelInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSimulation()}
              placeholder="e.g. gpt-4o"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Request Path</label>
            <input
              value={pathInput}
              onChange={(e) => setPathInput(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSimulation()}
              placeholder={DEFAULT_PATH}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={runSimulation}
              disabled={!modelInput.trim() || !data}
              className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 md:w-auto"
            >
              Test Match
            </button>
          </div>
        </div>
        {pathInput && (
          <p className="mt-2 text-xs text-gray-500">
            Detected protocol: {" "}
            <span className={`rounded border px-1.5 py-0.5 ${protocolBadgeClass(detectRequestProtocol(pathInput))}`}>
              {detectRequestProtocol(pathInput)}
            </span>
          </p>
        )}

        {simulatorResult && (
          <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3">
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className="text-sm text-gray-500">Result for</span>
              <CopyableCode className="rounded bg-white px-1.5 py-0.5 text-xs">{simulatorResult.model}</CopyableCode>
              <span className={`rounded border px-1.5 py-0.5 text-xs ${protocolBadgeClass(simulatorResult.protocol)}`}>
                {simulatorResult.protocol}
              </span>
            </div>
            {simulatorResult.winner ? (
              <div className="space-y-3">
                <div className="rounded border border-green-200 bg-green-50 p-2">
                  <div className="mb-1 text-xs font-medium text-green-700">Winning Upstream</div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{simulatorResult.winner.name}</span>
                    <span className="text-xs text-gray-500">priority {simulatorResult.winner.priority}</span>
                    <CopyableCode className="rounded bg-white px-1.5 py-0.5 text-xs">{simulatorResult.winner.matchedPattern}</CopyableCode>
                    <MatchTypeBadge type={simulatorResult.winner.matchType} />
                  </div>
                </div>
                {simulatorResult.candidates.length > 1 && (
                  <div>
                    <div className="mb-1 text-xs font-medium text-gray-600">
                      All Candidates ({simulatorResult.candidates.length})
                    </div>
                    <div className="space-y-1">
                      {simulatorResult.candidates.map((c) => {
                        const isWinner = c.upstreamId === simulatorResult.winner?.upstreamId;
                        return (
                          <div
                            key={c.upstreamId}
                            className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1.5 text-sm ${
                              isWinner
                                ? "border-green-200 bg-green-50"
                                : "border-gray-200 bg-white"
                            }`}
                          >
                            <span className={isWinner ? "font-semibold text-green-700" : ""}>{c.name}</span>
                            <span className="text-xs text-gray-500">priority {c.priority}</span>
                            <CopyableCode className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">{c.matchedPattern}</CopyableCode>
                            <MatchTypeBadge type={c.matchType} />
                            {isWinner && <span className="ml-auto text-xs font-medium text-green-700">winner</span>}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            ) : (
              <div className="text-sm text-red-600">
                No upstream configured for{" "}
                <CopyableCode className="rounded bg-white px-1 py-0.5 text-xs">{simulatorResult.model}</CopyableCode>{" "}
                under protocol{" "}
                <span className={`rounded border px-1 py-0.5 text-xs ${protocolBadgeClass(simulatorResult.protocol)}`}>
                  {simulatorResult.protocol}
                </span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* 静态路由表 */}
      <div className="rounded-lg bg-white p-4 shadow">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-semibold">Model Routing Table</h2>
          <div className="flex rounded-md overflow-hidden border border-gray-300">
            {data?.protocols.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setSelectedProtocol(p)}
                className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                  selectedProtocol === p
                    ? "bg-blue-600 text-white"
                    : "bg-white text-gray-600 hover:bg-gray-50"
                }`}
              >
                {p}
              </button>
            ))}
          </div>
        </div>

        {wildcardPatterns.length > 0 && (
          <div className="mb-3 rounded border border-purple-100 bg-purple-50/50 p-2 text-xs text-purple-700">
            <span className="font-medium">Wildcard patterns configured: </span>
            {wildcardPatterns.map((w, i) => (
              <span key={`${w.upstreamId}-${w.pattern}`}>
                <CopyableCode className="rounded bg-white px-1 py-0.5">{w.pattern}</CopyableCode> ({w.name}, p{w.priority})
                {i < wildcardPatterns.length - 1 ? ", " : ""}
              </span>
            ))}
          </div>
        )}

        {routesForProtocol.length === 0 ? (
          <div className="py-8 text-center text-sm text-gray-400">
            No concrete models configured for {selectedProtocol}.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-xs text-gray-400">
                  <th className="px-2 py-2">Model</th>
                  <th className="px-2 py-2">Winner Upstream</th>
                  <th className="px-2 py-2">Priority</th>
                  <th className="px-2 py-2">Pattern</th>
                  <th className="px-2 py-2">Type</th>
                  <th className="px-2 py-2">Candidates</th>
                  <th className="px-2 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {routesForProtocol.map((route) => {
                  const key = `${route.protocol}:${route.model}`;
                  const expanded = expandedModels.has(key);
                  const hasConflict = route.candidates.length > 1;
                  return (
                    <>
                      <tr
                        key={key}
                        className={`cursor-pointer hover:bg-gray-50 ${
                          hasConflict ? "bg-amber-50/30" : ""
                        }`}
                        onClick={() => toggleExpanded(key)}
                      >
                        <td className="px-2 py-2">
                          <CopyableCode className="text-xs">{route.model}</CopyableCode>
                        </td>
                        <td className="px-2 py-2 font-medium">
                          {route.winner ? route.winner.name : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-xs text-gray-500">
                          {route.winner ? route.winner.priority : "—"}
                        </td>
                        <td className="px-2 py-2">
                          {route.winner ? (
                            <CopyableCode className="text-xs">{route.winner.matchedPattern}</CopyableCode>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {route.winner ? <MatchTypeBadge type={route.winner.matchType} /> : "—"}
                        </td>
                        <td className="px-2 py-2 text-xs text-gray-500">
                          {route.candidates.length}
                        </td>
                        <td className="px-2 py-2 text-right text-xs text-gray-400">
                          {expanded ? "▲" : "▼"}
                        </td>
                      </tr>
                      {expanded && (
                        <tr key={`${key}-detail`}>
                          <td colSpan={7} className="px-2 py-2">
                            <div className="rounded border border-gray-200 bg-gray-50 p-2 text-xs">
                              <div className="mb-2 font-medium text-gray-600">
                                All matching upstreams
                              </div>
                              <div className="space-y-1">
                                {route.candidates.map((c) => {
                                  const isWinner = c.upstreamId === route.winner?.upstreamId;
                                  return (
                                    <div
                                      key={c.upstreamId}
                                      className={`flex flex-wrap items-center gap-2 rounded border px-2 py-1 ${
                                        isWinner
                                          ? "border-green-200 bg-green-50"
                                          : "border-gray-200 bg-white"
                                      }`}
                                    >
                                      <span className={isWinner ? "font-semibold text-green-700" : ""}>
                                        {c.name}
                                      </span>
                                      <span className="text-gray-500">priority {c.priority}</span>
                                      <CopyableCode className="rounded bg-gray-100 px-1 py-0.5">{c.matchedPattern}</CopyableCode>
                                      <MatchTypeBadge type={c.matchType} />
                                      {isWinner && (
                                        <span className="ml-auto font-medium text-green-700">winner</span>
                                      )}
                                    </div>
                                  );
                                })}
                              </div>
                              {hasConflict && route.winner && (
                                <p className="mt-2 text-[11px] text-gray-500">
                                  Winner is determined by exact match first, then lowest priority number.
                                  Ties are broken by upstream order.
                                </p>
                              )}
                            </div>
                          </td>
                        </tr>
                      )}
                    </>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
