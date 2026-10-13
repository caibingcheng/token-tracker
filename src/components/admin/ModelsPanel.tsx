"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import { detectRequestProtocol, type Protocol } from "@/lib/gateway/model-router";
import {
  simulateRoute,
  type SimRouteResult,
  type SimNamedRoute,
} from "@/lib/gateway/simulate-route";
import { CopyableCode } from "./CopyableCode";
import PricePickerModal from "./PricePickerModal";
import NamedRoutesPanel from "./NamedRoutesPanel";
import {
  AdminMobileCard,
  AdminMobileCards,
  AdminTable,
  AdminTableBody,
  AdminTableCard,
  AdminTableHead,
  AdminTd,
} from "./table";

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
  source: "named" | "auto";
  winner: CandidateInfo | null;
  candidates: CandidateInfo[];
  effective: EffectiveRoute;
  overridden?: boolean;
  shadowedCandidates?: CandidateInfo[];
  namedRouteUnavailable?: boolean;
  classifier?: { classifierUpstreamName: string; classifierModel: string; kind?: "model" | "priority" } | null;
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
  namedRoutes?: SimNamedRoute[];
}

interface PriceRow {
  model: string;
  upstreams: string[];
  inputPrice: number | null;
  outputPrice: number | null;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  source: "models.dev" | "github" | "manual" | null;
  modelsDevId: string | null;
  sourceProvider: string | null;
  updatedAt: string | null;
  recentActivity: boolean;
  status: {
    active: boolean;
    inactive: boolean;
    pending: boolean;
    unmatched: boolean;
    hasUpdate: boolean;
    removed: boolean;
    zeroNoPrice: boolean;
    diff: {
      inputPrice: number;
      outputPrice: number;
      cacheReadPrice: number | null;
      cacheWritePrice: number | null;
    } | null;
  };
}

const DEFAULT_PATH = "/v1/chat/completions";

type ModelsDevSource = "models.dev" | "github";

function modelSourceLabel(source: ModelsDevSource): string {
  return source === "github" ? "LiteLLM" : "models.dev";
}

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

function MatchTypeBadge({ type }: { type: "exact" | "wildcard" | "named" }) {
  const cls =
    type === "exact"
      ? "bg-green-50 text-green-700"
      : type === "wildcard"
        ? "bg-purple-50 text-purple-700"
        : "bg-indigo-50 text-indigo-700";
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

// 命名路由 + LLM 分类器 + 多目标：链首请求时决策，静态无确定性 winner
function classifierDecides(route: ResolvedRoute): boolean {
  return (
    route.source === "named" &&
    route.classifier?.kind !== "priority" &&
    route.candidates.length > 1
  );
}

// 模拟器结果面板：命名路由短路 / 自动路由统一渲染
function RouteSimulationResult({ result, model }: { result: SimRouteResult; model: string }) {
  const winner = result.winner;
  // LLM 分类器多目标：链首请求时决策，静态无确定性 winner
  const classifierDecides =
    result.source === "named" && result.classifier?.kind !== "priority" && result.candidates.length > 1;
  if (result.namedRouteUnavailable) {
    return (
      <div className="text-sm text-red-600">
        Named route targets unavailable: no valid upstream targets for{" "}
        <CopyableCode className="rounded bg-white px-1 py-0.5 text-xs">{model}</CopyableCode>{" "}
        (gateway returns 502 <code className="text-xs">named_route_unavailable</code>)
        {result.skipped.length > 0 && (
          <p className="mt-1 text-[11px] text-gray-500">
            Skipped:{" "}
            {result.skipped.map((s) => (
              <span key={s.upstreamId} className="mr-2">
                upstream #{s.upstreamId} → {s.targetModel} ({s.reason})
              </span>
            ))}
          </p>
        )}
      </div>
    );
  }
  if (!winner) {
    return (
      <div className="text-sm text-red-600">
        No upstream configured for{" "}
        <CopyableCode className="rounded bg-white px-1 py-0.5 text-xs">{model}</CopyableCode>
      </div>
    );
  }
  return (
    <div className="space-y-3">
      <div className="rounded border border-green-200 bg-green-50 p-2">
        <div className="mb-1 flex flex-wrap items-center gap-2 text-xs font-medium text-green-700">
          {classifierDecides ? "Decision" : "Winning Upstream"}
          <EffectiveBadge effective={result.effective} />
        </div>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          {classifierDecides ? (
            <>
              <span className="font-semibold">{result.classifier!.classifierModel}</span>
              <span className="text-xs text-gray-500">
                on {result.classifier!.classifierUpstreamName}
              </span>
              <span className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] text-indigo-700">
                classifier decides per session
              </span>
            </>
          ) : (
            <>
              <span className="font-semibold">{result.effective.winner?.name ?? winner.name}</span>
              <span className="text-xs text-gray-500">priority {result.effective.winner?.priority ?? winner.priority}</span>
              <CopyableCode className="rounded bg-white px-1.5 py-0.5 text-xs">
                {result.effective.winner?.matchedPattern ?? winner.matchedPattern}
              </CopyableCode>
              <MatchTypeBadge type={(result.effective.winner ?? winner).matchType} />
              <HealthBadges candidate={result.effective.winner ?? winner} />
              {result.source === "named" && (
                <span
                  className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700"
                  title="Rule classifier: chain head = first healthy target by priority; zero LLM cost"
                >
                  rule: priority
                </span>
              )}
            </>
          )}
        </div>
        {result.source === "named" && (
          <p className="mt-1 text-[11px] text-blue-700">
            Named route: request model is rewritten to{" "}
            <code className="text-xs">{(result.effective.winner ?? winner)?.matchedPattern}</code> before going upstream.
          </p>
        )}
        {classifierDecides && (
          <p className="mt-1 text-[11px] text-indigo-700">
            Named route: the chain head is chosen per session by classifier{" "}
            <code className="text-xs">{result.classifier!.classifierModel}</code> on{" "}
            {result.classifier!.classifierUpstreamName} (first request), then pinned by session binding.
            Candidates below = the target pool; the first entry is the fallback head when the
            classifier is unavailable.
          </p>
        )}
        {result.source === "auto" && result.effective.failover && winner && (
          <p className="mt-1 text-[11px] text-amber-700">
            Static winner {winner.name} is unhealthy — actual route uses fallback.
          </p>
        )}
      </div>
      {result.skipped.length > 0 && (
        <p className="text-[11px] text-gray-500">
          Skipped targets (disabled/missing upstream — gateway skips these):{" "}
          {result.skipped.map((s) => (
            <span key={s.upstreamId} className="mr-2">
              #{s.upstreamId} → {s.targetModel} ({s.reason})
            </span>
          ))}
        </p>
      )}
      {result.candidates.length > 1 && (
        <div>
          <div className="mb-1 text-xs font-medium text-gray-600">
            All Candidates ({result.candidates.length})
          </div>
          <div className="space-y-1">
            {result.candidates.map((c) => {
              const w = result.effective.winner;
              const isModelVm = classifierDecides;
              // LLM 分类器候选池无确定性 winner：priority 最小 route 标为 fallback head
              const isWinner =
                !isModelVm && c.upstreamId === w?.upstreamId && c.matchedPattern === w?.matchedPattern;
              const isFallbackHead = isModelVm && c === result.candidates[0];
              return (
                <div
                  key={`${c.upstreamId}:${c.matchedPattern}`}
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
                  {isFallbackHead && (
                    <span
                      className="ml-auto rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700"
                      title="Priority-min route: chain head when the classifier is unavailable"
                    >
                      fallback head
                    </span>
                  )}
                  {isWinner && <span className="ml-auto text-xs font-medium text-green-700">winner</span>}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
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
    result: SimRouteResult | null;
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
  const [modelsDevSource, setModelsDevSource] = useState<ModelsDevSource>("models.dev");
  const [snapshotSource, setSnapshotSource] = useState<ModelsDevSource | null>(null);
  const [savingSource, setSavingSource] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // silent = 联动刷新（命名路由面板写操作后）：不闪整页 loading
  const load = async (silent = false) => {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
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
      if (!silent) setLoading(false);
    }
  };

  useEffect(() => {
    load();
    loadPrices();
    loadSourceConfig();
  }, []);

  const loadSourceConfig = async () => {
    try {
      const res = await apiFetch("/api/admin/settings/models-dev-source");
      const json = await res.json();
      if (json.success) {
        setModelsDevSource(json.data.source as ModelsDevSource);
        setSnapshotSource((json.data.snapshotSource as ModelsDevSource) ?? null);
      }
    } catch {
      // 静默：源下拉保持默认，快照源提示不显示
    }
  };

  const changeModelsDevSource = async (value: ModelsDevSource) => {
    const prev = modelsDevSource;
    setModelsDevSource(value);
    setSavingSource(true);
    setPricesSuccess(null);
    try {
      const res = await apiFetch("/api/admin/settings/models-dev-source", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ source: value }),
      });
      const json = await res.json();
      if (json.success) {
        setPricesSuccess("Data source saved · refresh to apply");
      } else {
        setPricesError(json.error || "Failed to save data source");
        setModelsDevSource(prev);
      }
    } catch {
      setPricesError("Network error");
      setModelsDevSource(prev);
    } finally {
      setSavingSource(false);
    }
  };

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
        await Promise.all([loadPrices(), loadSourceConfig()]);
        const fetchedAt = json.data?.fetchedAt;
        const source = json.data?.source as ModelsDevSource | undefined;
        setPricesSuccess(
          `${modelSourceLabel(source ?? modelsDevSource)} snapshot refreshed and price reference updated${
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

  const refillAllPrices = async () => {
    if (!window.confirm("Overwrite all auto-filled prices (skips manually edited rows), continue?")) return;
    setPricesBusy(true);
    setPricesError(null);
    try {
      const res = await apiFetch("/api/admin/model-prices/auto-fill", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: "force" }),
      });
      const json = await res.json();
      if (json.success) {
        await loadPrices();
        setPricesSuccess(
          `Re-fill done: ${json.data.filled.length} filled · ${json.data.updated.length} updated · ${json.data.skipped.length} skipped · ${json.data.unmatched.length} unmatched`
        );
      } else {
        setPricesError(json.error || "Re-fill failed");
      }
    } catch {
      setPricesError("Network error");
    } finally {
      setPricesBusy(false);
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

  const runSimulation = () => {
    const model = modelInput.trim();
    const path = pathInput.trim() || DEFAULT_PATH;
    if (!model || !data) return;
    const protocol = detectRequestProtocol(path);
    setSimulatorResult({
      protocol,
      model,
      result: simulateRoute(model, protocol, data.upstreams, data.namedRoutes ?? []),
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
              {simulatorResult.result && (
                <span className="text-xs text-gray-500">
                  via{" "}
                  {simulatorResult.result.source === "named" ? (
                    <MatchTypeBadge type="named" />
                  ) : (
                    <span className="rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-600">auto</span>
                  )}
                </span>
              )}
            </div>
            {simulatorResult.result ? (
              <RouteSimulationResult result={simulatorResult.result} model={simulatorResult.model} />
            ) : (
              <div className="text-sm text-red-600">No match</div>
            )}
          </div>
        )}
      </div>

      <NamedRoutesPanel onChanged={() => load(true)} />


      {/* 静态路由表 */}
      <AdminTableCard
        title={<h2 className="text-base font-semibold">Model Routing Table</h2>}
        actions={
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
        }
      >

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
            <AdminTable>
              <AdminTableHead
                columns={[
                  { label: "Model" },
                  { label: "Winner Upstream" },
                  { label: "Priority" },
                  { label: "Pattern" },
                  { label: "Type" },
                  { label: "Candidates" },
                  { label: "", align: "right" },
                ]}
              />
              <AdminTableBody>
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
                        <AdminTd>
                          <CopyableCode className="text-xs">{route.model}</CopyableCode>
                          {route.overridden && (
                            <span
                              className="ml-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
                              title="Automatic routing is shadowed by a named route with the same name; the named route fully replaces automatic routing"
                            >
                              overridden
                            </span>
                          )}
                        </AdminTd>
                        <AdminTd className="font-medium">
                          {classifierDecides(route) ? (
                            <span
                              className="text-indigo-700"
                              title="Chain head is chosen by the classifier at request time (first request per session), then pinned by session binding"
                            >
                              {route.classifier!.classifierModel}
                              <span className="ml-1.5 text-[11px] font-normal text-gray-500">
                                classifier decides
                              </span>
                            </span>
                          ) : route.effective.winner ? (
                            <>
                              <span className="mr-1.5">{route.effective.winner.name}</span>
                              <EffectiveBadge effective={route.effective} />
                              {route.source === "named" && (
                                <span
                                  className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700"
                                  title="Rule classifier: chain head = first healthy target by priority; zero LLM cost"
                                >
                                  rule: priority
                                </span>
                              )}
                            </>
                          ) : route.namedRouteUnavailable ? (
                            <span
                              className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700"
                              title="Named route has no valid targets; requests get 502 named_route_unavailable"
                            >
                              no valid targets
                            </span>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </AdminTd>
                        <AdminTd className="text-xs text-gray-500">
                          {classifierDecides(route)
                            ? "—"
                            : route.effective.winner
                              ? route.effective.winner.priority
                              : "—"}
                        </AdminTd>
                        <AdminTd>
                          {classifierDecides(route) ? (
                            <span className="text-gray-400">—</span>
                          ) : route.effective.winner ? (
                            <CopyableCode className="text-xs">{route.effective.winner.matchedPattern}</CopyableCode>
                          ) : (
                            <span className="text-gray-400">—</span>
                          )}
                        </AdminTd>
                        <AdminTd>
                          {route.source === "named" ? (
                            <MatchTypeBadge type="named" />
                          ) : route.effective.winner ? (
                            <MatchTypeBadge type={route.effective.winner.matchType} />
                          ) : (
                            "—"
                          )}
                        </AdminTd>
                        <AdminTd className="text-xs text-gray-500">
                          {route.candidates.length}
                        </AdminTd>
                        <AdminTd align="right" className="text-xs text-gray-400">
                          {expanded ? "▲" : "▼"}
                        </AdminTd>
                      </tr>
                      {expanded && (
                        <tr key={`${key}-detail`}>
                          <AdminTd colSpan={7}>
                            <div className="rounded border border-gray-200 bg-gray-50 p-2 text-xs">
                              {route.classifier && (
                                <p className="mb-2 text-[11px] text-indigo-700">
                                  {route.classifier!.kind === "priority" ? (
                                    <>Rule classifier: chain head = first healthy target by priority
                                    (zero LLM cost); pinned per session by binding.</>
                                  ) : (
                                    <>Classifier: <code>{route.classifier!.classifierModel}</code> on{" "}
                                    {route.classifier!.classifierUpstreamName} — the chain head is chosen
                                    at request time (first request per session), then pinned by
                                    session binding; the first pool entry is the fallback head used
                                    when the classifier is unavailable.</>
                                  )}
                                </p>
                              )}
                                <div className="mb-2 font-medium text-gray-600">
                                  All matching upstreams
                                </div>
                                <div className="space-y-1">
                                  {route.candidates.map((c) => {
                                    const w = route.effective.winner;
                                    const isWinner =
                                      c.upstreamId === w?.upstreamId && c.matchedPattern === w?.matchedPattern;
                                    // 命名路由目标池（LLM 分类器）：priority 最小目标 = 分类器不可用时的回退链首（非确定性 winner）
                                    const fallbackHead = classifierDecides(route)
                                      ? route.candidates[0]
                                      : null;
                                    const isFallbackHead =
                                      fallbackHead != null &&
                                      c.upstreamId === fallbackHead.upstreamId &&
                                      c.matchedPattern === fallbackHead.matchedPattern;
                                    return (
                                      <div
                                        key={`${c.upstreamId}:${c.matchedPattern}`}
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
                                        {isFallbackHead && (
                                          <span
                                            className="ml-auto rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700"
                                            title="Priority-min route: chain head when the classifier is unavailable"
                                          >
                                            fallback head
                                          </span>
                                        )}
                                        {isWinner && (
                                          <span className="ml-auto font-medium text-green-700">winner</span>
                                        )}
                                      </div>
                                    );
                                  })}
                                </div>
                                {route.shadowedCandidates && route.shadowedCandidates.length > 0 && (
                                  <div className="mt-2">
                                    <div className="mb-1 font-medium text-gray-500">
                                      Shadowed automatic routing
                                    </div>
                                    <div className="space-y-1 opacity-70">
                                      {route.shadowedCandidates.map((c) => (
                                        <div
                                          key={`${c.upstreamId}:${c.matchedPattern}`}
                                          className="flex flex-wrap items-center gap-2 rounded border border-gray-200 bg-white px-2 py-1"
                                        >
                                          <span>{c.name}</span>
                                          <span className="text-gray-500">priority {c.priority}</span>
                                          <CopyableCode className="rounded bg-gray-100 px-1 py-0.5">{c.matchedPattern}</CopyableCode>
                                          <MatchTypeBadge type={c.matchType} />
                                          <HealthBadges candidate={c} />
                                        </div>
                                      ))}
                                    </div>
                                    <p className="mt-1 text-[11px] text-gray-500">
                                      Named route fully replaces automatic routing for this model name.
                                    </p>
                                  </div>
                                )}
{hasConflict && route.effective.winner && (
                                  <p className="mt-2 text-[11px] text-gray-500">
                                    Winner is determined by exact match first, then lowest priority number.
                                    Ties are broken by upstream order.
                                  </p>
                                )}
                              </div>
                            </AdminTd>
                          </tr>
                        )}
                      </>
                    );
                  })}
                </AdminTableBody>
              </AdminTable>

            {/* 移动端卡片 */}
            <AdminMobileCards>
              {routesForProtocol.map((route) => {
                const key = `${route.protocol}:${route.model}`;
                const expanded = expandedModels.has(key);
                const hasConflict = route.candidates.length > 1;
                return (
                  <AdminMobileCard key={key} className="overflow-hidden">
                    <button
                      type="button"
                      onClick={() => toggleExpanded(key)}
                      className={`w-full px-4 py-3 text-left ${hasConflict ? "bg-amber-50/30" : ""}`}
                    >
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <CopyableCode className="text-xs">{route.model}</CopyableCode>
                          {route.overridden && (
                            <span
                              className="ml-1.5 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] font-medium text-gray-500"
                              title="Automatic routing is shadowed by a named route with the same name; the named route fully replaces automatic routing"
                            >
                              overridden
                            </span>
                          )}
                          <div className="mt-1 text-sm font-medium text-gray-900">
                            {classifierDecides(route) ? (
                              <span
                                className="text-indigo-700"
                                title="Chain head is chosen by the classifier at request time (first request per session), then pinned by session binding"
                              >
                                {route.classifier!.classifierModel}
                                <span className="ml-1.5 text-[11px] font-normal text-gray-500">
                                  classifier decides
                                </span>
                              </span>
                            ) : route.effective.winner ? (
                              <>
                                <span className="mr-1.5">{route.effective.winner.name}</span>
                                <EffectiveBadge effective={route.effective} />
                                {route.source === "named" && (
                                  <span
                                    className="rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700"
                                    title="Rule classifier: chain head = first healthy target by priority; zero LLM cost"
                                  >
                                    rule: priority
                                  </span>
                                )}
                              </>
                            ) : route.namedRouteUnavailable ? (
                              <span className="rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">
                                no valid targets
                              </span>
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
                        {route.source === "named" ? (
                          <MatchTypeBadge type="named" />
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
                        {route.classifier && (
                          <p className="mb-2 text-[11px] text-indigo-700">
                            {route.classifier!.kind === "priority" ? (
                              <>Rule classifier: chain head = first healthy target by priority (zero
                              LLM cost); pinned per session by binding.</>
                            ) : (
                              <>Classifier: <code>{route.classifier!.classifierModel}</code> on{" "}
                              {route.classifier!.classifierUpstreamName} — the chain head is chosen at
                              request time (first request per session), then pinned by session
                              binding; the first pool entry is the fallback head used when the
                              classifier is unavailable.</>
                            )}
                          </p>
                        )}
                        <div className="mb-2 font-medium text-gray-600">
                          All matching upstreams
                        </div>
                        <div className="space-y-1">
                          {route.candidates.map((c) => {
                            const w = route.effective.winner;
                            const isWinner =
                              c.upstreamId === w?.upstreamId && c.matchedPattern === w?.matchedPattern;
                            // 命名路由目标池（LLM 分类器）：priority 最小目标 = 分类器不可用时的回退链首（非确定性 winner）
                            const fallbackHead = classifierDecides(route)
                              ? route.candidates[0]
                              : null;
                            const isFallbackHead =
                              fallbackHead != null &&
                              c.upstreamId === fallbackHead.upstreamId &&
                              c.matchedPattern === fallbackHead.matchedPattern;
                            return (
                              <div
                                key={`${c.upstreamId}:${c.matchedPattern}`}
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
                                {isFallbackHead && (
                                  <span
                                    className="ml-auto rounded bg-indigo-50 px-1.5 py-0.5 text-[10px] font-medium text-indigo-700"
                                    title="Priority-min route: chain head when the classifier is unavailable"
                                  >
                                    fallback head
                                  </span>
                                )}
                                {isWinner && (
                                  <span className="ml-auto font-medium text-green-700">winner</span>
                                )}
                              </div>
                            );
                          })}
                        </div>
                        {route.shadowedCandidates && route.shadowedCandidates.length > 0 && (
                          <div className="mt-2">
                            <div className="mb-1 font-medium text-gray-500">
                              Shadowed automatic routing
                            </div>
                            <div className="space-y-1 opacity-70">
                              {route.shadowedCandidates.map((c) => (
                                <div
                                  key={`${c.upstreamId}:${c.matchedPattern}`}
                                  className="flex flex-wrap items-center gap-2 rounded border border-gray-200 bg-white px-2 py-1"
                                >
                                  <span>{c.name}</span>
                                  <span className="text-gray-500">priority {c.priority}</span>
                                  <CopyableCode className="rounded bg-gray-100 px-1 py-0.5">{c.matchedPattern}</CopyableCode>
                                  <MatchTypeBadge type={c.matchType} />
                                  <HealthBadges candidate={c} />
                                </div>
                              ))}
                            </div>
                            <p className="mt-1 text-[11px] text-gray-500">
                              Named route fully replaces automatic routing for this model name.
                            </p>
                          </div>
                        )}
                        {hasConflict && route.effective.winner && (
                          <p className="mt-2 text-[11px] text-gray-500">
                            Winner is determined by exact match first, then lowest priority number.
                            Ties are broken by upstream order.
                          </p>
                        )}
                      </div>
                    )}
                  </AdminMobileCard>
                );
              })}
            </AdminMobileCards>
          </>
        )}
      </AdminTableCard>

      {/* 官方价参考：Models List Table */}
      <AdminTableCard
        title={
          <div>
            <h2 className="text-base font-semibold">Model Pricing</h2>
            <p className="mt-0.5 text-xs text-gray-400">
              Official price reference (USD / 1M tokens). Calculated on query; historical costs recompute on price change.
            </p>
            {snapshotSource && snapshotSource !== modelsDevSource && (
              <p className="mt-1 text-[11px] text-amber-600">
                Snapshot source: {modelSourceLabel(snapshotSource)} · refresh to switch
              </p>
            )}
          </div>
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={modelsDevSource}
              onChange={(e) => changeModelsDevSource(e.target.value as ModelsDevSource)}
              disabled={savingSource}
              title="Snapshot data source; saved on change, applied on next refresh"
              className="rounded border border-gray-300 bg-white px-2 py-1.5 text-xs text-gray-700 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:opacity-50 min-h-[36px] md:min-h-0"
            >
              <option value="models.dev">models.dev</option>
              <option value="github">GitHub LiteLLM</option>
            </select>
            <button
              type="button"
              disabled={refreshingSnapshot}
              onClick={refreshModelsDev}
              className="rounded border border-gray-200 bg-white px-3 py-1.5 text-xs font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50 whitespace-nowrap min-h-[36px] md:min-h-0"
            >
              {refreshingSnapshot ? "Refreshing…" : "Refresh"}
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
              disabled={pricesBusy}
              onClick={autoFillPrices}
              className="rounded border border-blue-200 bg-blue-50 px-3 py-1.5 text-xs font-medium text-blue-700 hover:bg-blue-100 disabled:opacity-50 min-h-[36px] md:min-h-0"
            >
              Auto-fill unmatched
            </button>
            <button
              type="button"
              disabled={pricesBusy}
              onClick={refillAllPrices}
              className="rounded border border-green-200 bg-green-50 px-3 py-1.5 text-xs font-medium text-green-700 hover:bg-green-100 disabled:opacity-50 min-h-[36px] md:min-h-0"
            >
              Re-fill all
            </button>
            <label className="flex items-center gap-1.5 text-xs text-gray-600 sm:ml-2 sm:border-l sm:border-gray-200 sm:pl-3">
              <input
                type="checkbox"
                checked={showInactive}
                onChange={(e) => setShowInactive(e.target.checked)}
                className="h-4 w-4 rounded border-gray-300"
              />
              Show removed
            </label>
          </div>
        }
      >

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
            : priceRows.filter((r) => r.status.active || r.recentActivity);
          if (visibleRows.length === 0) {
            return (
              <div className="py-8 text-center text-sm text-gray-400">
                No models with pricing info. Save an upstream with concrete models to get started.
              </div>
            );
          }
          return (
            <>
              <AdminTable>
                <AdminTableHead
                  columns={[
                    { label: "Model" },
                    { label: "Upstreams" },
                    { label: "Input", align: "right" },
                    { label: "Output", align: "right" },
                    { label: "Cache Rd", align: "right" },
                    { label: "Cache Wr", align: "right" },
                    { label: "Status" },
                    { label: "Actions", align: "right" },
                  ]}
                />
                <AdminTableBody>
                  {visibleRows.map((row) => (
                    <tr key={row.model} className={row.status.inactive && !row.recentActivity ? "opacity-50" : ""}>
                      <AdminTd>
                        <CopyableCode className="text-xs">{row.model}</CopyableCode>
                      </AdminTd>
                      <AdminTd className="text-xs text-gray-500">
                        {row.upstreams.length > 0 ? row.upstreams.join(", ") : "—"}
                      </AdminTd>
                      <AdminTd align="right" mono>
                        {row.inputPrice === null ? "—" : `$${row.inputPrice.toFixed(4)}`}
                      </AdminTd>
                      <AdminTd align="right" mono>
                        {row.outputPrice === null ? "—" : `$${row.outputPrice.toFixed(4)}`}
                      </AdminTd>
                      <AdminTd align="right" mono>
                        {row.cacheReadPrice === null ? "—" : `$${row.cacheReadPrice.toFixed(4)}`}
                      </AdminTd>
                      <AdminTd align="right" mono>
                        {row.cacheWritePrice === null ? "—" : `$${row.cacheWritePrice.toFixed(4)}`}
                      </AdminTd>
                      <AdminTd>
                        <PriceBadges row={row} onAdopt={() => adoptUpdate(row)} onPick={() => setPricePickerModel(row.model)} />
                      </AdminTd>
                      <AdminTd align="right" className="whitespace-nowrap">
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
                      </AdminTd>
                    </tr>
                  ))}
                </AdminTableBody>
              </AdminTable>

              {/* 移动端卡片 */}
              <AdminMobileCards>
                {visibleRows.map((row) => (
                  <AdminMobileCard
                    key={row.model}
                    className={row.status.inactive && !row.recentActivity ? "opacity-50" : ""}
                  >
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
                  </AdminMobileCard>
                ))}
              </AdminMobileCards>
            </>
          );
        })()}
      </AdminTableCard>

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

  if (row.source === "models.dev" || row.source === "github") {
    const label = modelSourceLabel(row.source);
    badges.push({
      key: "src",
      cls: "bg-green-50 text-green-700 border-green-200",
      label: row.sourceProvider ? `${label} · ${row.sourceProvider}` : label,
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
  if (row.status.zeroNoPrice) {
    badges.push({
      key: "zero-price",
      cls: "bg-amber-50 text-amber-700 border-amber-200",
      label: "check price",
      title: "No official price in snapshot, but stored price is 0 — likely overwritten by an earlier force Re-fill. Confirm or delete this row.",
    });
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
