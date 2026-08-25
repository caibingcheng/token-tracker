"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import {
  detectRequestProtocol,
  routeModelByProtocol,
  type ModelCandidate,
  type Protocol,
  type UpstreamRoute,
} from "@/lib/gateway/model-router";
import { CopyableCode } from "./CopyableCode";
import PricePickerModal from "./PricePickerModal";

interface UpstreamSummary {
  id: number;
  name: string;
  protocol: Protocol;
  baseUrl: string;
  priority: number;
  enabled: boolean;
  enabledModels: string[];
  unhealthy: boolean;
  modelUnhealthy: string[];
}

interface CandidateInfo {
  upstreamId: number;
  name: string;
  priority: number;
  matchedPattern: string;
  matchType: "exact" | "wildcard";
  upstreamUnhealthy: boolean;
  modelUnavailable: boolean;
}

interface EffectiveRoute {
  winner: CandidateInfo | null;
  failover: boolean;
  allUnhealthy: boolean;
}

interface ResolvedRoute {
  protocol: Protocol;
  model: string;
  source: "manual" | "auto";
  winner: CandidateInfo | null;
  candidates: CandidateInfo[];
  effective: EffectiveRoute;
  overridden?: boolean;
}

interface ManualRouteInfo {
  id: number;
  name: string;
  protocol: Protocol;
  upstreamId: number;
  upstreamName: string;
  upstreamProtocol: Protocol;
  targetModel: string;
  priority: number;
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
  manualRoutes: ManualRouteInfo[];
}

interface PriceRow {
  model: string;
  upstreams: string[];
  inputPrice: number | null;
  outputPrice: number | null;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  source: "models.dev" | "manual" | null;
  modelsDevId: string | null;
  sourceProvider: string | null;
  updatedAt: string | null;
  status: {
    active: boolean;
    inactive: boolean;
    pending: boolean;
    unmatched: boolean;
    hasUpdate: boolean;
    removed: boolean;
    diff: {
      inputPrice: number;
      outputPrice: number;
      cacheReadPrice: number | null;
      cacheWritePrice: number | null;
    } | null;
  };
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

function MatchTypeBadge({ type }: { type: "exact" | "wildcard" | "manual" }) {
  const cls =
    type === "exact"
      ? "bg-green-50 text-green-700"
      : type === "wildcard"
        ? "bg-purple-50 text-purple-700"
        : "bg-blue-50 text-blue-700";
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] ${cls}`}>
      {type}
    </span>
  );
}

// 候选健康徽标：upstream 级 unhealthy / model 级不可用
function HealthBadges({ candidate }: { candidate: CandidateInfo }) {
  if (!candidate.upstreamUnhealthy && !candidate.modelUnavailable) return null;
  return (
    <>
      {candidate.upstreamUnhealthy && (
        <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
          unhealthy
        </span>
      )}
      {candidate.modelUnavailable && (
        <span className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">
          model unavailable
        </span>
      )}
    </>
  );
}

// 实际路由徽标：failover（退避路由）/ last resort（全不健康兜底）
function EffectiveBadge({ effective }: { effective: EffectiveRoute }) {
  if (effective.allUnhealthy) {
    return (
      <span
        className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700"
        title="All candidates are unhealthy; requests fall back to trying them anyway"
      >
        last resort
      </span>
    );
  }
  if (effective.failover) {
    return (
      <span
        className="rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700"
        title="Top-priority upstream is unhealthy; requests are routed to this fallback"
      >
        failover
      </span>
    );
  }
  return null;
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
    effective: EffectiveRoute;
  } | null>(null);

  const [selectedProtocol, setSelectedProtocol] = useState<Protocol>("openai");
  const [expandedModels, setExpandedModels] = useState<Set<string>>(new Set());

  // Models List Table（官方价参考）
  const [priceRows, setPriceRows] = useState<PriceRow[]>([]);
  const [showInactive, setShowInactive] = useState(false);
  const [pricePickerModel, setPricePickerModel] = useState<string | null>(null);
  const [pricesBusy, setPricesBusy] = useState(false);
  const [pricesError, setPricesError] = useState<string | null>(null);
  const [refreshingSnapshot, setRefreshingSnapshot] = useState(false);
  const [uploadingSnapshot, setUploadingSnapshot] = useState(false);
  const [pricesSuccess, setPricesSuccess] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Manual Routing 表单
  const [ruleName, setRuleName] = useState("");
  const [ruleProtocol, setRuleProtocol] = useState<Protocol>("openai");
  const [ruleUpstreamId, setRuleUpstreamId] = useState<number | "">("");
  const [ruleTargetModel, setRuleTargetModel] = useState("");
  const [rulePriority, setRulePriority] = useState("0");
  const [showTargetSuggestions, setShowTargetSuggestions] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  // 行内编辑（priority / targetModel）
  const [editingRule, setEditingRule] = useState<{ id: number; priority: string; targetModel: string } | null>(null);
  const [savingRule, setSavingRule] = useState(false);

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
    loadPrices();
  }, []);

  const loadPrices = async () => {
    setPricesError(null);
    try {
      const res = await apiFetch("/api/admin/model-prices");
      const json = await res.json();
      if (json.success) {
        setPriceRows(json.data);
      } else {
        setPricesError(json.error || "Failed to load model prices");
      }
    } catch {
      setPricesError("Network error");
    }
  };

  const autoFillPrices = async () => {
    setPricesBusy(true);
    setPricesError(null);
    try {
      const res = await apiFetch("/api/admin/model-prices/auto-fill", { method: "POST" });
      const json = await res.json();
      if (json.success) {
        await loadPrices();
      } else {
        setPricesError(json.error || "Auto-fill failed");
      }
    } catch {
      setPricesError("Network error");
    } finally {
      setPricesBusy(false);
    }
  };

  const refreshModelsDev = async () => {
    setRefreshingSnapshot(true);
    setPricesError(null);
    setPricesSuccess(null);
    try {
      const res = await apiFetch("/api/admin/models-dev/refresh", { method: "POST" });
      const json = await res.json();
      if (json.success) {
        await loadPrices();
        const fetchedAt = json.data?.fetchedAt;
        setPricesSuccess(
          `models.dev snapshot refreshed and price reference updated${
            fetchedAt ? ` · fetched at ${new Date(fetchedAt).toLocaleString()}` : ""
          }`
        );
      } else {
        setPricesError(json.error || "Refresh failed");
      }
    } catch {
      setPricesError("Network error");
    } finally {
      setRefreshingSnapshot(false);
    }
  };

  const uploadSnapshotFile = async (file: File) => {
    setUploadingSnapshot(true);
    setPricesError(null);
    try {
      const text = await file.text();
      try {
        JSON.parse(text);
      } catch {
        setPricesError("Invalid JSON file — expected models.dev api.json");
        return;
      }
      const res = await apiFetch("/api/admin/models-dev/upload", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: text,
      });
      const json = await res.json();
      if (json.success) {
        await loadPrices();
        if (typeof json.dropped === "number" && json.dropped > 0) {
          setPricesError(`Uploaded models.dev snapshot, ${json.dropped} invalid entries skipped`);
        }
      } else {
        setPricesError(json.error || "Upload failed");
      }
    } catch {
      setPricesError("Network error");
    } finally {
      setUploadingSnapshot(false);
    }
  };

  const adoptUpdate = async (row: PriceRow) => {
    if (!row.modelsDevId) return;
    if (!window.confirm(`Adopt updated official price for "${row.model}"?`)) return;
    setPricesBusy(true);
    try {
      const res = await apiFetch("/api/admin/model-prices/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: row.model, modelsDevId: row.modelsDevId }),
      });
      const json = await res.json();
      if (json.success) {
        await loadPrices();
      } else {
        setPricesError(json.error || "Failed to adopt price");
      }
    } catch {
      setPricesError("Network error");
    } finally {
      setPricesBusy(false);
    }
  };

  const deletePrice = async (row: PriceRow) => {
    if (!window.confirm(`Delete price for "${row.model}"? Historical costs will drop to $0.`)) return;
    try {
      const res = await apiFetch(`/api/admin/model-prices?model=${encodeURIComponent(row.model)}`, {
        method: "DELETE",
      });
      const json = await res.json();
      if (json.success) {
        await loadPrices();
      } else {
        setPricesError(json.error || "Failed to delete price");
      }
    } catch {
      setPricesError("Network error");
    }
  };

  const upstreamRoutes = useMemo(
    () => (data ? data.upstreams.filter((u) => u.enabled).map(toUpstreamRoute) : []),
    [data]
  );

  // provider 下拉选项：按所选 protocol 过滤 + enabled 过滤
  const ruleUpstreamOptions = useMemo(() => {
    if (!data) return [];
    return data.upstreams.filter(
      (u) => u.enabled && u.protocol === ruleProtocol
    );
  }, [data, ruleProtocol]);

  // target model 候选 = 所选 upstream 的 enabledModels 非通配项
  const ruleTargetCandidates = useMemo(() => {
    const upstream = ruleUpstreamOptions.find((u) => u.id === ruleUpstreamId);
    if (!upstream) return [];
    return upstream.enabledModels.filter((m) => !m.endsWith("*"));
  }, [ruleUpstreamOptions, ruleUpstreamId]);

  const createRule = async () => {
    if (!ruleName.trim() || !ruleUpstreamId || !ruleTargetModel.trim()) return;
    setSubmitting(true);
    try {
      const res = await apiFetch("/api/admin/routing-rules", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          name: ruleName.trim(),
          protocol: ruleProtocol,
          upstreamId: ruleUpstreamId,
          targetModel: ruleTargetModel.trim(),
          priority: rulePriority.trim() === "" ? 0 : Number(rulePriority),
        }),
      });
      const json = await res.json();
      if (json.success) {
        setRuleName("");
        setRuleUpstreamId("");
        setRuleTargetModel("");
        setRulePriority("0");
        await load();
      } else {
        setError(json.error || "Failed to create routing rule");
      }
    } catch {
      setError("Network error");
    } finally {
      setSubmitting(false);
    }
  };

  const updateRule = async () => {
    if (!editingRule) return;
    const priority = Number(editingRule.priority);
    if (!Number.isInteger(priority) || priority < 0) {
      setError("Priority must be a non-negative integer");
      return;
    }
    if (!editingRule.targetModel.trim()) {
      setError("Target model cannot be empty");
      return;
    }
    setSavingRule(true);
    try {
      const res = await apiFetch(`/api/admin/routing-rules/${editingRule.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          priority,
          targetModel: editingRule.targetModel.trim(),
        }),
      });
      const json = await res.json();
      if (json.success) {
        setEditingRule(null);
        await load();
      } else {
        setError(json.error || "Failed to update routing rule");
      }
    } catch {
      setError("Network error");
    } finally {
      setSavingRule(false);
    }
  };

  const deleteRule = async (rule: ManualRouteInfo) => {
    if (!window.confirm(`Delete manual route "${rule.name}" → ${rule.targetModel}?`)) return;
    try {
      const res = await apiFetch(`/api/admin/routing-rules/${rule.id}`, { method: "DELETE" });
      const json = await res.json();
      if (json.success) {
        await load();
      } else {
        setError(json.error || "Failed to delete routing rule");
      }
    } catch {
      setError("Network error");
    }
  };

  const runSimulation = () => {
    const model = modelInput.trim();
    const path = pathInput.trim() || DEFAULT_PATH;
    if (!model || !data) return;
    const protocol = detectRequestProtocol(path);
    const { winner, candidates } = routeModelByProtocol(model, protocol, upstreamRoutes);
    // 附加健康标记（与 /api/admin/models 同口径：upstream 级 unhealthy + model 级不可用）
    const toCandidateInfo = (c: ModelCandidate): CandidateInfo => {
      const upstream = data.upstreams.find((u) => u.id === c.upstream.id);
      return {
        upstreamId: c.upstream.id,
        name: c.upstream.name,
        priority: c.upstream.priority,
        matchedPattern: c.matchedPattern,
        matchType: c.matchType,
        upstreamUnhealthy: upstream?.unhealthy ?? false,
        modelUnavailable: upstream?.modelUnhealthy?.includes(model) ?? false,
      };
    };
    const candidateInfos = candidates.map(toCandidateInfo);
    const healthyFirst = candidateInfos.filter((c) => !c.upstreamUnhealthy && !c.modelUnavailable);
    const effective: EffectiveRoute =
      healthyFirst.length > 0
        ? {
            winner: healthyFirst[0],
            failover: healthyFirst[0].upstreamId !== candidateInfos[0]?.upstreamId,
            allUnhealthy: false,
          }
        : {
            winner: candidateInfos[0] ?? null,
            failover: false,
            allUnhealthy: candidateInfos.length > 0,
          };
    setSimulatorResult({
      protocol,
      model,
      winner: winner ? toCandidateInfo(winner) : null,
      candidates: candidateInfos,
      effective,
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
                  <div className="mb-1 flex flex-wrap items-center gap-2 text-xs font-medium text-green-700">
                    Winning Upstream
                    <EffectiveBadge effective={simulatorResult.effective} />
                  </div>
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <span className="font-semibold">{simulatorResult.effective.winner?.name ?? simulatorResult.winner.name}</span>
                    <span className="text-xs text-gray-500">priority {simulatorResult.effective.winner?.priority ?? simulatorResult.winner.priority}</span>
                    <CopyableCode className="rounded bg-white px-1.5 py-0.5 text-xs">
                      {simulatorResult.effective.winner?.matchedPattern ?? simulatorResult.winner.matchedPattern}
                    </CopyableCode>
                    <MatchTypeBadge type={(simulatorResult.effective.winner ?? simulatorResult.winner).matchType} />
                    <HealthBadges candidate={simulatorResult.effective.winner ?? simulatorResult.winner} />
                  </div>
                  {simulatorResult.effective.failover && simulatorResult.winner && (
                    <p className="mt-1 text-[11px] text-amber-700">
                      Static winner {simulatorResult.winner.name} is unhealthy — actual route uses fallback.
                    </p>
                  )}
                </div>
                {simulatorResult.candidates.length > 1 && (
                  <div>
                    <div className="mb-1 text-xs font-medium text-gray-600">
                      All Candidates ({simulatorResult.candidates.length})
                    </div>
                    <div className="space-y-1">
                      {simulatorResult.candidates.map((c) => {
                        const isWinner = c.upstreamId === simulatorResult.effective.winner?.upstreamId;
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
                            <HealthBadges candidate={c} />
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

      {/* 手动路由规则 */}
      <div className="rounded-lg bg-white p-4 shadow">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-semibold">Manual Routing</h2>
          <p className="text-xs text-gray-400">
            Manual rules completely replace automatic routing. Multiple targets fail over by priority; all fail → 502.
          </p>
        </div>

        {/* 新增行：name / protocol / provider / target model / priority */}
        <div className="grid grid-cols-1 md:grid-cols-[1fr_130px_1fr_1fr_90px_auto] gap-3">
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">New Model Name</label>
            <input
              value={ruleName}
              onChange={(e) => setRuleName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createRule()}
              placeholder="Virtual name clients request"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Protocol</label>
            <select
              value={ruleProtocol}
              onChange={(e) => {
                setRuleProtocol(e.target.value as Protocol);
                setRuleUpstreamId("");
                setRuleTargetModel("");
              }}
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {data?.protocols.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Provider</label>
            <select
              value={ruleUpstreamId}
              onChange={(e) => {
                setRuleUpstreamId(e.target.value === "" ? "" : Number(e.target.value));
                setRuleTargetModel("");
              }}
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              <option value="">Select upstream…</option>
              {ruleUpstreamOptions.map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
            {ruleUpstreamOptions.length === 0 && (
              <p className="mt-1 text-[11px] text-gray-400">
                No enabled {ruleProtocol} upstreams
              </p>
            )}
          </div>
          <div className="relative">
            <label className="mb-1 block text-xs font-medium text-gray-700">Target Model</label>
            <input
              value={ruleTargetModel}
              onChange={(e) => {
                setRuleTargetModel(e.target.value);
                setShowTargetSuggestions(true);
              }}
              onFocus={() => setShowTargetSuggestions(true)}
              onBlur={() => setTimeout(() => setShowTargetSuggestions(false), 150)}
              onKeyDown={(e) => e.key === "Enter" && createRule()}
              placeholder="Real model on upstream"
              disabled={!ruleUpstreamId}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50"
            />
            {showTargetSuggestions && ruleTargetCandidates.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded border border-gray-200 bg-white shadow-lg">
                {ruleTargetCandidates.map((m) => (
                  <button
                    key={m}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setRuleTargetModel(m);
                      setShowTargetSuggestions(false);
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                  >
                    <span>{m}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-xs font-medium text-gray-700">Priority</label>
            <input
              value={rulePriority}
              onChange={(e) => setRulePriority(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && createRule()}
              type="number"
              min={0}
              placeholder="0"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-end">
            <button
              type="button"
              onClick={createRule}
              disabled={!ruleName.trim() || !ruleUpstreamId || !ruleTargetModel.trim() || submitting}
              className="w-full rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50 md:w-auto"
            >
              {submitting ? "Adding…" : "Add Rule"}
            </button>
          </div>
        </div>

        {/* 规则列表 */}
        {data && data.manualRoutes.length > 0 && (
          <div className="mt-4">
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400">
                    <th className="px-2 py-2">Name</th>
                    <th className="px-2 py-2">Protocol</th>
                    <th className="px-2 py-2">Provider</th>
                    <th className="px-2 py-2">Target Model</th>
                    <th className="px-2 py-2">Priority</th>
                    <th className="px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {data.manualRoutes.map((rule) => {
                    const editing = editingRule?.id === rule.id;
                    return (
                      <tr key={rule.id}>
                        <td className="px-2 py-2">
                          <CopyableCode className="text-xs">{rule.name}</CopyableCode>
                        </td>
                        <td className="px-2 py-2">
                          <span className={`rounded border px-1.5 py-0.5 text-[10px] ${protocolBadgeClass(rule.protocol)}`}>
                            {rule.protocol}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          <span className="font-medium">{rule.upstreamName}</span>
                          <span className={`ml-1.5 rounded border px-1.5 py-0.5 text-[10px] ${protocolBadgeClass(rule.upstreamProtocol)}`}>
                            {rule.upstreamProtocol}
                          </span>
                        </td>
                        <td className="px-2 py-2">
                          {editing ? (
                            <input
                              value={editingRule!.targetModel}
                              onChange={(e) => setEditingRule({ ...editingRule!, targetModel: e.target.value })}
                              className="w-40 rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                            />
                          ) : (
                            <CopyableCode className="text-xs">{rule.targetModel}</CopyableCode>
                          )}
                        </td>
                        <td className="px-2 py-2">
                          {editing ? (
                            <input
                              value={editingRule!.priority}
                              onChange={(e) => setEditingRule({ ...editingRule!, priority: e.target.value })}
                              type="number"
                              min={0}
                              className="w-16 rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                            />
                          ) : (
                            <span className="inline-flex items-center rounded bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600">
                              p{rule.priority}
                            </span>
                          )}
                        </td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          {editing ? (
                            <>
                              <button
                                type="button"
                                onClick={updateRule}
                                disabled={savingRule}
                                className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
                              >
                                {savingRule ? "Saving…" : "Save"}
                              </button>
                              {" · "}
                              <button
                                type="button"
                                onClick={() => setEditingRule(null)}
                                className="text-xs text-gray-500 hover:text-gray-700"
                              >
                                Cancel
                              </button>
                            </>
                          ) : (
                            <>
                              <button
                                type="button"
                                onClick={() =>
                                  setEditingRule({
                                    id: rule.id,
                                    priority: String(rule.priority),
                                    targetModel: rule.targetModel,
                                  })
                                }
                                className="text-xs text-gray-600 hover:text-gray-800"
                              >
                                Edit
                              </button>
                              {" · "}
                              <button
                                type="button"
                                onClick={() => deleteRule(rule)}
                                className="text-xs text-red-500 hover:text-red-700"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <div className="md:hidden space-y-3">
              {data.manualRoutes.map((rule) => (
                <div key={rule.id} className="border border-gray-200 rounded-lg p-4">
                  <div className="flex justify-between items-start gap-2 mb-3">
                    <div className="min-w-0">
                      <p className="text-xs text-gray-500">Name</p>
                      <CopyableCode className="text-xs">{rule.name}</CopyableCode>
                    </div>
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="rounded bg-gray-50 px-1.5 py-0.5 text-xs text-gray-600">
                        p{rule.priority}
                      </span>
                      {editingRule?.id === rule.id ? (
                        <>
                          <button
                            type="button"
                            onClick={updateRule}
                            disabled={savingRule}
                            className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-600 disabled:opacity-50"
                          >
                            {savingRule ? "Saving…" : "Save"}
                          </button>
                          <button
                            type="button"
                            onClick={() => setEditingRule(null)}
                            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-500"
                          >
                            Cancel
                          </button>
                        </>
                      ) : (
                        <>
                          <button
                            type="button"
                            onClick={() =>
                              setEditingRule({
                                id: rule.id,
                                priority: String(rule.priority),
                                targetModel: rule.targetModel,
                              })
                            }
                            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            onClick={() => deleteRule(rule)}
                            className="rounded border border-red-200 px-2 py-1 text-xs text-red-500"
                          >
                            Delete
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <div>
                      <p className="text-xs text-gray-500">Protocol</p>
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] ${protocolBadgeClass(rule.protocol)}`}>
                        {rule.protocol}
                      </span>
                    </div>
                    <div>
                      <p className="text-xs text-gray-500">Provider</p>
                      <p className="text-sm font-medium">{rule.upstreamName}</p>
                      <span className={`rounded border px-1.5 py-0.5 text-[10px] ${protocolBadgeClass(rule.upstreamProtocol)}`}>
                        {rule.upstreamProtocol}
                      </span>
                    </div>
                    <div className="col-span-2">
                      <p className="text-xs text-gray-500">Target Model</p>
                      {editingRule?.id === rule.id ? (
                        <input
                          value={editingRule.targetModel}
                          onChange={(e) => setEditingRule({ ...editingRule, targetModel: e.target.value })}
                          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                        />
                      ) : (
                        <CopyableCode className="text-xs">{rule.targetModel}</CopyableCode>
                      )}
                    </div>
                    {editingRule?.id === rule.id && (
                      <div className="col-span-2">
                        <p className="text-xs text-gray-500">Priority</p>
                        <input
                          value={editingRule.priority}
                          onChange={(e) => setEditingRule({ ...editingRule, priority: e.target.value })}
                          type="number"
                          min={0}
                          className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                        />
                      </div>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* 静态路由表 */}
      <div className="rounded-lg bg-white p-4 shadow">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-base font-semibold">Model Routing Table</h2>
          <div className="flex overflow-x-auto overflow-y-hidden scrollbar-hide rounded-md border border-gray-300">
            {data?.protocols.map((p) => (
              <button
                key={p}
                type="button"
                onClick={() => setSelectedProtocol(p)}
                className={`shrink-0 whitespace-nowrap px-3 py-1.5 text-xs font-medium transition-colors min-h-[40px] md:min-h-0 ${
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
          <>
            <div className="hidden md:block overflow-x-auto">
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
                            {route.source === "auto" && route.overridden && (
                              <span
                                className="ml-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
                                title="Overridden by a manual route with the same name; manual route fully replaces automatic routing"
                              >
                                overridden
                              </span>
                            )}
                          </td>
                          <td className="px-2 py-2 font-medium">
                            {route.effective.winner ? (
                              <>
                                <span className="mr-1.5">{route.effective.winner.name}</span>
                                <EffectiveBadge effective={route.effective} />
                              </>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2 text-xs text-gray-500">
                            {route.effective.winner ? route.effective.winner.priority : "—"}
                          </td>
                          <td className="px-2 py-2">
                            {route.effective.winner ? (
                              <CopyableCode className="text-xs">{route.effective.winner.matchedPattern}</CopyableCode>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </td>
                          <td className="px-2 py-2">
                            {route.source === "manual" ? (
                              <MatchTypeBadge type="manual" />
                            ) : route.effective.winner ? (
                              <MatchTypeBadge type={route.effective.winner.matchType} />
                            ) : (
                              "—"
                            )}
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
                                    const isWinner = c.upstreamId === route.effective.winner?.upstreamId;
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
                                        <HealthBadges candidate={c} />
                                        {isWinner && (
                                          <span className="ml-auto font-medium text-green-700">winner</span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                                {hasConflict && route.effective.winner && (
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
            <div className="md:hidden space-y-3">
              {routesForProtocol.map((route) => {
                const key = `${route.protocol}:${route.model}`;
                const expanded = expandedModels.has(key);
                const hasConflict = route.candidates.length > 1;
                return (
                  <div key={key} className="border border-gray-200 rounded-lg overflow-hidden">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(key)}
                      className={`w-full px-4 py-3 text-left ${hasConflict ? "bg-amber-50/30" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <CopyableCode className="text-xs">{route.model}</CopyableCode>
                          {route.source === "auto" && route.overridden && (
                            <span
                              className="ml-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
                              title="Overridden by a manual route with the same name; manual route fully replaces automatic routing"
                            >
                              overridden
                            </span>
                          )}
                          <div className="mt-1 text-sm font-medium text-gray-900">
                            {route.effective.winner ? (
                              <>
                                <span className="mr-1.5">{route.effective.winner.name}</span>
                                <EffectiveBadge effective={route.effective} />
                              </>
                            ) : (
                              <span className="text-gray-400">—</span>
                            )}
                          </div>
                        </div>
                        <span className="shrink-0 text-xs text-gray-400">{expanded ? "▲" : "▼"}</span>
                      </div>
                      <div className="mt-2 flex flex-wrap items-center gap-2 text-xs text-gray-500">
                        {route.effective.winner && (
                          <>
                            <span>priority {route.effective.winner.priority}</span>
                            <CopyableCode className="rounded bg-gray-100 px-1 py-0.5">{route.effective.winner.matchedPattern}</CopyableCode>
                          </>
                        )}
                        {route.source === "manual" ? (
                          <MatchTypeBadge type="manual" />
                        ) : route.effective.winner ? (
                          <MatchTypeBadge type={route.effective.winner.matchType} />
                        ) : (
                          "—"
                        )}
                        <span className="text-gray-400">{route.candidates.length} candidate(s)</span>
                      </div>
                    </button>
                    {expanded && (
                      <div className="border-t border-gray-100 bg-gray-50 p-3 text-xs">
                        <div className="mb-2 font-medium text-gray-600">
                          All matching upstreams
                        </div>
                        <div className="space-y-1">
                          {route.candidates.map((c) => {
                            const isWinner = c.upstreamId === route.effective.winner?.upstreamId;
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
                                <HealthBadges candidate={c} />
                                {isWinner && (
                                  <span className="ml-auto font-medium text-green-700">winner</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {hasConflict && route.effective.winner && (
                          <p className="mt-2 text-[11px] text-gray-500">
                            Winner is determined by exact match first, then lowest priority number.
                            Ties are broken by upstream order.
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* 官方价参考：Models List Table */}
      <div className="rounded-lg bg-white p-4 shadow">
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-base font-semibold">Model Pricing</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              Official price reference (USD / 1M tokens). Calculated on query; historical costs recompute on price change.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="flex items-center gap-1.5 text-xs text-gray-600">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              Show removed
            </label>
            <button
              type="button"
              disabled={pricesBusy}
              onClick={autoFillPrices}
              className="rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 min-h-[36px] md:min-h-0"
            >
              Auto-fill unmatched
            </button>
            <input
              ref={fileInputRef}
              type="file"
              accept=".json,application/json"
              className="hidden"
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file) uploadSnapshotFile(file);
                e.target.value = "";
              }}
            />
            <button
              type="button"
              disabled={uploadingSnapshot}
              onClick={() => fileInputRef.current?.click()}
              className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 min-h-[36px] md:min-h-0"
            >
              {uploadingSnapshot ? "Uploading…" : "Upload…"}
            </button>
            <button
              type="button"
              disabled={refreshingSnapshot}
              onClick={refreshModelsDev}
              className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 min-h-[36px] md:min-h-0"
            >
              {refreshingSnapshot ? "Refreshing…" : "Refresh models.dev"}
            </button>
          </div>
        </div>

        {pricesError && (
          <div className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {pricesError}
          </div>
        )}
        {pricesSuccess && (
          <div className="mb-3 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-600">
            {pricesSuccess}
          </div>
        )}

        {(() => {
          const visibleRows = showInactive
            ? priceRows
            : priceRows.filter((r) => r.status.active);
          if (visibleRows.length === 0) {
            return (
              <div className="py-8 text-center text-sm text-gray-400">
                No models with pricing info. Save an upstream with concrete models to get started.
              </div>
            );
          }
          return (
            <>
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs text-gray-400">
                      <th className="px-2 py-2">Model</th>
                      <th className="px-2 py-2">Upstreams</th>
                      <th className="px-2 py-2 text-right">Input</th>
                      <th className="px-2 py-2 text-right">Output</th>
                      <th className="px-2 py-2 text-right">Cache Rd</th>
                      <th className="px-2 py-2 text-right">Cache Wr</th>
                      <th className="px-2 py-2">Status</th>
                      <th className="px-2 py-2 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {visibleRows.map((row) => (
                      <tr key={row.model} className={row.status.inactive ? "opacity-50" : ""}>
                        <td className="px-2 py-2">
                          <CopyableCode className="text-xs">{row.model}</CopyableCode>
                        </td>
                        <td className="px-2 py-2 text-xs text-gray-500">
                          {row.upstreams.length > 0 ? row.upstreams.join(", ") : "—"}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-xs">
                          {row.inputPrice === null ? "—" : `$${row.inputPrice.toFixed(4)}`}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-xs">
                          {row.outputPrice === null ? "—" : `$${row.outputPrice.toFixed(4)}`}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-xs">
                          {row.cacheReadPrice === null ? "—" : `$${row.cacheReadPrice.toFixed(4)}`}
                        </td>
                        <td className="px-2 py-2 text-right font-mono text-xs">
                          {row.cacheWritePrice === null ? "—" : `$${row.cacheWritePrice.toFixed(4)}`}
                        </td>
                        <td className="px-2 py-2">
                          <PriceBadges row={row} onAdopt={() => adoptUpdate(row)} onPick={() => setPricePickerModel(row.model)} />
                        </td>
                        <td className="px-2 py-2 text-right whitespace-nowrap">
                          <button
                            type="button"
                            onClick={() => setPricePickerModel(row.model)}
                            className="text-xs text-blue-600 hover:text-blue-800"
                          >
                            {row.inputPrice === null ? "Select price" : "Edit"}
                          </button>
                          {row.inputPrice !== null && (
                            <>
                              {" · "}
                              <button
                                type="button"
                                onClick={() => deletePrice(row)}
                                className="text-xs text-red-500 hover:text-red-700"
                              >
                                Delete
                              </button>
                            </>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* 移动端卡片 */}
              <div className="md:hidden space-y-3">
                {visibleRows.map((row) => (
                  <div key={row.model} className={`border border-gray-200 rounded-lg p-3 ${row.status.inactive ? "opacity-50" : ""}`}>
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <CopyableCode className="text-xs">{row.model}</CopyableCode>
                        <p className="mt-0.5 text-[11px] text-gray-400">
                          {row.upstreams.length > 0 ? row.upstreams.join(", ") : "No upstream"}
                        </p>
                      </div>
                      <PriceBadges row={row} onAdopt={() => adoptUpdate(row)} onPick={() => setPricePickerModel(row.model)} />
                    </div>
                    <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-600">
                      <span>Input <span className="float-right font-mono">{row.inputPrice === null ? "—" : `$${row.inputPrice.toFixed(4)}`}</span></span>
                      <span>Output <span className="float-right font-mono">{row.outputPrice === null ? "—" : `$${row.outputPrice.toFixed(4)}`}</span></span>
                      <span>Cache Rd <span className="float-right font-mono">{row.cacheReadPrice === null ? "—" : `$${row.cacheReadPrice.toFixed(4)}`}</span></span>
                      <span>Cache Wr <span className="float-right font-mono">{row.cacheWritePrice === null ? "—" : `$${row.cacheWritePrice.toFixed(4)}`}</span></span>
                    </div>
                    <div className="mt-3 flex items-center gap-3">
                      <button
                        type="button"
                        onClick={() => setPricePickerModel(row.model)}
                        className="rounded bg-blue-600 px-3 py-2 text-xs font-medium text-white hover:bg-blue-700"
                      >
                        {row.inputPrice === null ? "Select price" : "Edit"}
                      </button>
                      {row.inputPrice !== null && (
                        <button
                          type="button"
                          onClick={() => deletePrice(row)}
                          className="text-xs text-red-500 hover:text-red-700"
                        >
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </>
          );
        })()}
      </div>

      <PricePickerModal
        isOpen={pricePickerModel !== null}
        onClose={() => setPricePickerModel(null)}
        model={pricePickerModel ?? ""}
        onSaved={loadPrices}
      />
    </div>
  );
}

// 价格状态徽标组（桌面/移动端共用）
function PriceBadges({
  row,
  onAdopt,
  onPick,
}: {
  row: PriceRow;
  onAdopt: () => void;
  onPick: () => void;
}) {
  const badges: Array<{ key: string; cls: string; label: string; action?: () => void; title?: string }> = [];

  if (row.source === "models.dev") {
    badges.push({
      key: "src",
      cls: "bg-green-50 text-green-700 border-green-200",
      label: row.sourceProvider ? `models.dev · ${row.sourceProvider}` : "models.dev",
      title: row.modelsDevId ?? undefined,
    });
  } else if (row.source === "manual") {
    badges.push({ key: "src", cls: "bg-gray-50 text-gray-700 border-gray-200", label: "manual" });
  }
  if (row.status.inactive) {
    badges.push({ key: "inactive", cls: "bg-gray-50 text-gray-500 border-gray-200", label: "removed" });
  }
  if (row.status.unmatched) {
    badges.push({ key: "unmatched", cls: "bg-red-50 text-red-700 border-red-200", label: "unmatched", action: onPick });
  } else if (row.status.pending) {
    badges.push({ key: "pending", cls: "bg-amber-50 text-amber-700 border-amber-200", label: "confirm", action: onPick });
  }
  if (row.status.hasUpdate) {
    badges.push({
      key: "update",
      cls: "bg-blue-50 text-blue-700 border-blue-200",
      label: "update",
      action: onAdopt,
      title: row.status.diff
        ? `New: input $${row.status.diff.inputPrice} / output $${row.status.diff.outputPrice}`
        : "Official price changed",
    });
  }
  if (row.status.removed) {
    badges.push({ key: "removed", cls: "bg-red-50 text-red-700 border-red-200", label: "removed", action: onPick });
  }

  if (badges.length === 0) return null;

  return (
    <span className="inline-flex flex-wrap gap-1">
      {badges.map((b) => (
        <button
          key={b.key}
          type="button"
          onClick={b.action}
          disabled={!b.action}
          title={b.title}
          className={`rounded border px-1.5 py-0.5 text-[10px] font-medium ${b.cls} ${b.action ? "hover:opacity-70" : "cursor-default"}`}
        >
          {b.label}
        </button>
      ))}
    </span>
  );
}
