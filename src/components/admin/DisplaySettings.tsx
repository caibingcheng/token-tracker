"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";

interface DisplayData {
  groups: Array<{ name: string; patterns: string[] }>;
  envValue: string;
  envOverridden: boolean;
}

interface StatusPageElementsData {
  total: boolean;
  today: boolean;
  daily: boolean;
  heatmap: boolean;
  hourly: boolean;
  topModels: boolean;
  cost: boolean;
}

interface StatusPageConfigData {
  enabled: boolean;
  elements: StatusPageElementsData;
}

interface AliasRuleDraft {
  name: string;
  aliases: string;
}

interface HiddenGroupDraft {
  name: string;
  patterns: string;
}

interface HiddenSourcesData {
  upstreams: string[];
  virtualKeys: string[];
  excludedUpstreams: string[];
  excludedVirtualKeys: string[];
}

const UNKNOWN_AGENT = "unknown";
const UNKNOWN_DISPLAY = "(unknown)";

const STATUS_ELEMENT_LABELS: Array<{ key: keyof StatusPageElementsData; label: string; hint?: string }> = [
  { key: "total", label: "Total summary", hint: "All-time totals" },
  { key: "today", label: "Today overview", hint: "Today vs yesterday" },
  { key: "daily", label: "Daily trend chart", hint: "Last 30 days (fixed)" },
  { key: "heatmap", label: "Heatmap", hint: "Last 365 days" },
  { key: "hourly", label: "24h distribution", hint: "Requires daily trend" },
  { key: "topModels", label: "Top Models", hint: "Reveals model names & costs" },
  { key: "cost", label: "Cost amounts", hint: "Reveals USD costs" },
];

export default function DisplaySettings() {
  const [data, setData] = useState<DisplayData | null>(null);
  const [hiddenDraft, setHiddenDraft] = useState<HiddenGroupDraft[]>([]);
  const [hiddenBusy, setHiddenBusy] = useState(false);
  const [hiddenError, setHiddenError] = useState<string | null>(null);
  const [hiddenSaved, setHiddenSaved] = useState(false);
  const [statusConfig, setStatusConfig] = useState<StatusPageConfigData | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusSaved, setStatusSaved] = useState(false);
  const [aliasesDraft, setAliasesDraft] = useState<AliasRuleDraft[]>([]);
  const [aliasesBusy, setAliasesBusy] = useState(false);
  const [aliasesError, setAliasesError] = useState<string | null>(null);
  const [aliasesSaved, setAliasesSaved] = useState(false);
  const [hiddenSources, setHiddenSources] = useState<HiddenSourcesData | null>(null);
  const [providerOptions, setProviderOptions] = useState<string[]>([]);
  const [agentOptionsRaw, setAgentOptionsRaw] = useState<string[]>([]);
  const [hiddenSourcesBusy, setHiddenSourcesBusy] = useState(false);
  const [hiddenSourcesError, setHiddenSourcesError] = useState<string | null>(null);
  const [hiddenSourcesSaved, setHiddenSourcesSaved] = useState(false);

  const load = useCallback(async () => {
    const [res, statusRes, aliasesRes, hsRes, providersRes, agentsRes] = await Promise.all([
      apiFetch("/api/admin/settings/display"),
      apiFetch("/api/admin/settings/status"),
      apiFetch("/api/admin/settings/aliases"),
      apiFetch("/api/admin/settings/hidden-sources"),
      apiFetch("/api/providers?includeHidden=1"),
      apiFetch("/api/agents?includeHidden=1"),
    ]);
    const json = await res.json();
    const statusJson = await statusRes.json();
    const aliasesJson = await aliasesRes.json();
    const hsJson = await hsRes.json();
    const providersJson = await providersRes.json();
    const agentsJson = await agentsRes.json();
    if (json.success) {
      const d = json.data as DisplayData;
      setData(d);
      setHiddenDraft(
        d.groups.map((g) => ({ name: g.name, patterns: g.patterns.join(", ") }))
      );
    }
    if (statusJson.success) {
      const d = statusJson.data as { config: StatusPageConfigData };
      setStatusConfig(d.config);
    }
    if (aliasesJson.success) {
      const rules = aliasesJson.data as Array<{ name: string; aliases: string[] }>;
      setAliasesDraft(rules.map((r) => ({ name: r.name, aliases: r.aliases.join(", ") })));
    }
    if (hsJson.success) {
      const d = hsJson.data as { config: HiddenSourcesData };
      setHiddenSources(d.config);
    }
    if (providersJson.success) {
      const list = providersJson.data as Array<{ id: string; name: string }>;
      setProviderOptions(list.map((p) => p.id));
    }
    if (agentsJson.success) {
      const list = agentsJson.data as Array<{ id: string; name: string }>;
      setAgentOptionsRaw(list.map((a) => a.id));
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const updateHidden = (idx: number, patch: Partial<HiddenGroupDraft>) => {
    setHiddenSaved(false);
    setHiddenDraft((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    );
  };

  const addHiddenRow = () => {
    setHiddenSaved(false);
    setHiddenDraft((prev) => [...prev, { name: "", patterns: "" }]);
  };

  const removeHiddenRow = (idx: number) => {
    setHiddenSaved(false);
    setHiddenDraft((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSaveHidden = async () => {
    const groups = hiddenDraft
      .map((r) => ({
        name: r.name.trim(),
        patterns: r.patterns
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      }))
      .filter((r) => r.patterns.length > 0);
    setHiddenBusy(true);
    setHiddenError(null);
    setHiddenSaved(false);
    try {
      const res = await apiFetch("/api/admin/settings/display", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ groups }),
      });
      const json = await res.json();
      if (json.success) {
        setHiddenSaved(true);
        load();
      } else {
        setHiddenError(json.error || "Failed to save");
      }
    } catch {
      setHiddenError("Network error");
    } finally {
      setHiddenBusy(false);
    }
  };

  const handleSaveStatus = async () => {
    if (!statusConfig) return;
    setStatusBusy(true);
    setStatusError(null);
    setStatusSaved(false);
    try {
      const res = await apiFetch("/api/admin/settings/status", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: statusConfig }),
      });
      const json = await res.json();
      if (json.success) {
        setStatusSaved(true);
        load();
      } else {
        setStatusError(json.error || "Failed to save");
      }
    } catch {
      setStatusError("Network error");
    } finally {
      setStatusBusy(false);
    }
  };

  const toggleStatusElement = (key: keyof StatusPageElementsData) => {
    if (!statusConfig) return;
    setStatusSaved(false);
    setStatusConfig((prev) => {
      if (!prev) return prev;
      return {
        ...prev,
        elements: { ...prev.elements, [key]: !prev.elements[key] },
      };
    });
  };

  const toggleHiddenSource = (field: "upstreams" | "virtualKeys", name: string) => {
    setHiddenSourcesSaved(false);
    setHiddenSources((prev) => {
      if (!prev) return prev;
      const list = prev[field];
      const next = list.includes(name)
        ? list.filter((n) => n !== name)
        : [...list, name];
      return { ...prev, [field]: next };
    });
  };

  const toggleExcludedSource = (
    field: "excludedUpstreams" | "excludedVirtualKeys",
    name: string
  ) => {
    setHiddenSourcesSaved(false);
    setHiddenSources((prev) => {
      if (!prev) return prev;
      const list = prev[field];
      const next = list.includes(name)
        ? list.filter((n) => n !== name)
        : [...list, name];
      return { ...prev, [field]: next };
    });
  };

  const handleSaveHiddenSources = async () => {
    if (!hiddenSources) return;
    setHiddenSourcesBusy(true);
    setHiddenSourcesError(null);
    setHiddenSourcesSaved(false);
    try {
      const res = await apiFetch("/api/admin/settings/hidden-sources", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ config: hiddenSources }),
      });
      const json = await res.json();
      if (json.success) {
        setHiddenSourcesSaved(true);
        load();
      } else {
        setHiddenSourcesError(json.error || "Failed to save");
      }
    } catch {
      setHiddenSourcesError("Network error");
    } finally {
      setHiddenSourcesBusy(false);
    }
  };

  const updateAlias = (idx: number, patch: Partial<AliasRuleDraft>) => {
    setAliasesSaved(false);
    setAliasesDraft((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch } : r))
    );
  };

  const addAliasRule = () => {
    setAliasesSaved(false);
    setAliasesDraft((prev) => [...prev, { name: "", aliases: "" }]);
  };

  const removeAliasRule = (idx: number) => {
    setAliasesSaved(false);
    setAliasesDraft((prev) => prev.filter((_, i) => i !== idx));
  };

  const handleSaveAliases = async () => {
    const rules = aliasesDraft
      .map((r) => ({
        name: r.name.trim(),
        aliases: r.aliases
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
      }))
      .filter((r) => r.name !== "");
    setAliasesBusy(true);
    setAliasesError(null);
    setAliasesSaved(false);
    try {
      const res = await apiFetch("/api/admin/settings/aliases", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ rules }),
      });
      const json = await res.json();
      if (json.success) {
        setAliasesSaved(true);
        load();
      } else {
        setAliasesError(json.error || "Failed to save");
      }
    } catch {
      setAliasesError("Network error");
    } finally {
      setAliasesBusy(false);
    }
  };

  // 选项 = 数据库现有名字 ∪ 已勾选隐藏/排除历史名字（记录删除后仍可取消）
  const upstreamOptions = (hs: HiddenSourcesData): string[] =>
    Array.from(
      new Set([...providerOptions, ...hs.upstreams, ...hs.excludedUpstreams])
    ).sort((a, b) => a.localeCompare(b));
  const agentOptions = (hs: HiddenSourcesData): string[] =>
    Array.from(
      new Set([
        ...agentOptionsRaw,
        ...hs.virtualKeys,
        ...hs.excludedVirtualKeys,
      ])
    )
      .filter((name) => name !== UNKNOWN_AGENT)
      .sort((a, b) => a.localeCompare(b));

  return (
    <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
      <h2 className="mb-1 text-lg font-semibold text-gray-900">Display</h2>
      <p className="mb-4 text-sm text-gray-500">
        Provider anonymization (HIDDEN_PROVIDERS). Saved here overrides the{" "}
        <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">HIDDEN_PROVIDERS</code>{" "}
        environment variable; once saved, env is ignored.
      </p>

      {data?.envOverridden && (
        <div className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
          env HIDDEN_PROVIDERS has been overridden by the panel.
        </div>
      )}
      {data?.envValue && !data.envOverridden && (
        <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
          Currently falling back to env HIDDEN_PROVIDERS. Save a value here to
          take over.
        </div>
      )}

      <label className="mb-1 block text-sm font-medium text-gray-700">
        Hidden provider groups
      </label>
      <div className="space-y-2">
        {hiddenDraft.map((rule, idx) => (
          <div key={idx} className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2">
            <input
              value={rule.name}
              onChange={(e) => updateHidden(idx, { name: e.target.value })}
              placeholder="Display name (empty = Provider A, B, C...)"
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base md:text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <input
              value={rule.patterns}
              onChange={(e) => updateHidden(idx, { patterns: e.target.value })}
              placeholder="patterns, comma separated (e.g. vendor*, vendor-partner)"
              spellCheck={false}
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 font-mono text-base md:text-xs shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            <button
              type="button"
              onClick={() => removeHiddenRow(idx)}
              className="rounded border border-red-200 px-3 py-2 text-sm text-red-500 hover:bg-red-50 min-h-[40px] md:min-h-0"
            >
              Remove
            </button>
          </div>
        ))}
        {hiddenDraft.length === 0 && (
          <p className="text-sm text-gray-400">No hidden provider groups configured.</p>
        )}
        <button
          type="button"
          onClick={addHiddenRow}
          className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
        >
          + Add row
        </button>
      </div>
      <p className="mt-1 text-xs text-gray-400">
        Each row is one group; comma separates patterns within a group;
        <code className="rounded bg-gray-100 px-1">*</code> suffix = prefix match.
        Empty display name renders as Provider A, B, C... Multiple providers in
        the same group are merged into one entry in provider-level stats (Top
        Providers, daily stacked chart, Speed table).
      </p>

      {hiddenError && (
        <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {hiddenError}
        </div>
      )}
      {hiddenSaved && (
        <div className="mt-3 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          Saved. Changes take effect immediately.
        </div>
      )}

      <button
        type="button"
        onClick={handleSaveHidden}
        disabled={hiddenBusy}
        className="mt-4 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-50"
      >
        {hiddenBusy ? "Saving..." : "Save"}
      </button>

      <div className="mt-8 border-t border-gray-100 pt-6">
        <h3 className="mb-1 text-base font-semibold text-gray-900">
          Model Aliases
        </h3>
        <p className="mb-4 text-sm text-gray-500">
          Normalize model names across providers into a display group. Each row:
          a group name and comma-separated aliases. Models not matching any row
          keep their original name. Pricing is always computed on the real model
          name; aliases only affect display roll-up.
        </p>

        <div className="space-y-2">
          {aliasesDraft.map((rule, idx) => (
            <div key={idx} className="grid grid-cols-1 md:grid-cols-[1fr_2fr_auto] gap-2">
              <input
                value={rule.name}
                onChange={(e) => updateAlias(idx, { name: e.target.value })}
                placeholder="Group name (e.g. Claude Sonnet 4.6)"
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-base md:text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <input
                value={rule.aliases}
                onChange={(e) => updateAlias(idx, { aliases: e.target.value })}
                placeholder="aliases, comma separated (e.g. claude-sonnet-4-6, anthropic/claude-sonnet-4-6)"
                spellCheck={false}
                className="w-full rounded border border-gray-300 bg-white px-3 py-2 font-mono text-base md:text-xs shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              <button
                type="button"
                onClick={() => removeAliasRule(idx)}
                className="rounded border border-red-200 px-3 py-2 text-sm text-red-500 hover:bg-red-50 min-h-[40px] md:min-h-0"
              >
                Remove
              </button>
            </div>
          ))}
          {aliasesDraft.length === 0 && (
            <p className="text-sm text-gray-400">No alias groups configured.</p>
          )}
          <button
            type="button"
            onClick={addAliasRule}
            className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50"
          >
            + Add row
          </button>
        </div>

        {aliasesError && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {aliasesError}
          </div>
        )}
        {aliasesSaved && (
          <div className="mt-3 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
            Saved. Normalized names update immediately.
          </div>
        )}

        <button
          type="button"
          onClick={handleSaveAliases}
          disabled={aliasesBusy}
          className="mt-4 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-50"
        >
          {aliasesBusy ? "Saving..." : "Save Aliases"}
        </button>
      </div>

      <div className="mt-8 border-t border-gray-100 pt-6">
        <h3 className="mb-1 text-base font-semibold text-gray-900">
          Public Status Page
        </h3>
        <p className="mb-4 text-sm text-gray-500">
          Exposes a public usage panel on the home page{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">/</code>{" "}
          for unauthenticated visitors, with no authentication. Disabled by
          default; enable explicitly to open the endpoint. Data is cached for
          60s and rate-limited.
        </p>

        {statusConfig && (
          <div className="space-y-4">
            <label className="flex items-center gap-3 min-h-[40px] cursor-pointer">
              <input
                type="checkbox"
                checked={statusConfig.enabled}
                onChange={() => {
                  setStatusSaved(false);
                  setStatusConfig((prev) =>
                    prev ? { ...prev, enabled: !prev.enabled } : prev
                  );
                }}
                className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
              />
              <span className="text-sm font-medium text-gray-700">
                Enable public status page
              </span>
            </label>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                Elements
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {STATUS_ELEMENT_LABELS.map(({ key, label, hint }) => (
                  <label
                    key={key}
                    className="flex items-center gap-3 min-h-[40px] rounded border border-gray-200 bg-gray-50 px-3 py-2 cursor-pointer"
                  >
                    <input
                      type="checkbox"
                      checked={statusConfig.elements[key]}
                      onChange={() => toggleStatusElement(key)}
                      className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="min-w-0">
                      <span className="block text-sm font-medium text-gray-700">
                        {label}
                      </span>
                      {hint && (
                        <span className="block text-xs text-gray-400">
                          {hint}
                        </span>
                      )}
                    </span>
                  </label>
                ))}
              </div>
              <p className="mt-2 text-xs text-gray-400">
                Default: Total summary, Today overview, Daily trend chart.
                Top Models &amp; Cost reveal sensitive data — leave off unless
                intended for public display.
              </p>
            </div>

            {statusError && (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                {statusError}
              </div>
            )}
            {statusSaved && (
              <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
                Saved. The public page reflects the new configuration
                immediately.
              </div>
            )}

            <button
              type="button"
              onClick={handleSaveStatus}
              disabled={statusBusy}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-50"
            >
              {statusBusy ? "Saving..." : "Save Status Page"}
            </button>
          </div>
        )}
      </div>

      <div className="mt-8 border-t border-gray-100 pt-6">
        <h3 className="mb-1 text-base font-semibold text-gray-900">
          Hidden Sources
        </h3>
        <p className="mb-4 text-sm text-gray-500">
          Hide deprecated virtual keys / upstreams by name, and optionally
          exclude each one from aggregate totals. Hidden sources disappear
          from filters and rankings; excluded sources are removed from all
          aggregate stats (total cards, daily, heatmap, hourly, latency,
          public status page). The two are independent per source. No data
          is ever deleted — unchecking fully restores everything.
        </p>

        {hiddenSources && (
          <div className="space-y-4">
            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                Upstreams
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {upstreamOptions(hiddenSources).map((name) => {
                  const hidden = hiddenSources.upstreams.includes(name);
                  const excluded = hiddenSources.excludedUpstreams.includes(name);
                  return (
                    <div
                      key={name}
                      className="flex items-center gap-3 min-h-[40px] rounded border border-gray-200 bg-gray-50 px-3 py-2"
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                        <input
                          type="checkbox"
                          checked={hidden}
                          onChange={() => toggleHiddenSource("upstreams", name)}
                          className="h-5 w-5 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-gray-700" title={name}>
                            {name}
                          </span>
                          <span className="block text-xs text-gray-400">
                            {excluded ? "Excluded from totals" : "Counted in totals"}
                          </span>
                        </span>
                      </label>
                      <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={excluded}
                          onChange={() =>
                            toggleExcludedSource("excludedUpstreams", name)
                          }
                          className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-xs text-gray-500">Exclude</span>
                      </label>
                    </div>
                  );
                })}
                {upstreamOptions(hiddenSources).length === 0 && (
                  <p className="text-sm text-gray-400">No providers with records yet.</p>
                )}
              </div>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                Virtual Keys
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {agentOptions(hiddenSources).map((name) => {
                  const hidden = hiddenSources.virtualKeys.includes(name);
                  const excluded = hiddenSources.excludedVirtualKeys.includes(name);
                  return (
                    <div
                      key={name}
                      className="flex items-center gap-3 min-h-[40px] rounded border border-gray-200 bg-gray-50 px-3 py-2"
                    >
                      <label className="flex min-w-0 flex-1 cursor-pointer items-center gap-3">
                        <input
                          type="checkbox"
                          checked={hidden}
                          onChange={() => toggleHiddenSource("virtualKeys", name)}
                          className="h-5 w-5 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-medium text-gray-700" title={name}>
                            {name}
                          </span>
                          <span className="block text-xs text-gray-400">
                            {excluded ? "Excluded from totals" : "Counted in totals"}
                          </span>
                        </span>
                      </label>
                      <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
                        <input
                          type="checkbox"
                          checked={excluded}
                          onChange={() =>
                            toggleExcludedSource("excludedVirtualKeys", name)
                          }
                          className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                        />
                        <span className="text-xs text-gray-500">Exclude</span>
                      </label>
                    </div>
                  );
                })}
                {agentOptions(hiddenSources).length === 0 && (
                  <p className="text-sm text-gray-400">No virtual keys with records yet.</p>
                )}
              </div>
              <p className="mt-2 text-xs text-gray-400">
                Attributed to{" "}
                <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">
                  {UNKNOWN_DISPLAY}
                </code>{" "}
                records are always counted and never hidden.
              </p>
            </div>

            {hiddenSourcesError && (
              <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                {hiddenSourcesError}
              </div>
            )}
            {hiddenSourcesSaved && (
              <div className="rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
                Saved. Filters and totals update immediately.
              </div>
            )}

            <button
              type="button"
              onClick={handleSaveHiddenSources}
              disabled={hiddenSourcesBusy}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-50"
            >
              {hiddenSourcesBusy ? "Saving..." : "Save Hidden Sources"}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
