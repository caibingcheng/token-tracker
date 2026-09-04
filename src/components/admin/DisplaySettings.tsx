"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import {
  AdminMobileCard,
  AdminMobileCards,
  AdminMobileEmpty,
  AdminTable,
  AdminTableBody,
  AdminTableEmptyRow,
  AdminTableHead,
  AdminTd,
} from "./table";

interface DisplayData {
  groups: Array<{ name: string; patterns: string[] }>;
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

interface ObservedAgentToken {
  token: string;
  name: string;
  source: "manual" | "builtin" | "as-is";
}

// 行数据 = 服务端持久态（load 即落库）；pending = 已追加但未保存的新行
interface HiddenGroupRule {
  name: string;
  patterns: string;
  pending?: boolean;
}

interface AliasRule {
  name: string;
  aliases: string;
  pending?: boolean;
}

interface AgentAliasRule {
  name: string;
  aliases: string;
  pending?: boolean;
}

interface HiddenSourcesData {
  upstreams: string[];
  virtualKeys: string[];
  excludedUpstreams: string[];
  excludedVirtualKeys: string[];
}

interface PutResult {
  ok: boolean;
  error: string;
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

// 行级 Actions 桌面样式：文本链接 Edit · Delete / Save · Cancel（对齐 ModelsPanel routing rules）
function DesktopActions({
  editing,
  busy,
  canSave,
  onSave,
  onCancel,
  onEdit,
  onDelete,
}: {
  editing: boolean;
  busy: boolean;
  canSave: boolean;
  onSave: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return (
    <AdminTd align="right" className="whitespace-nowrap">
      {editing ? (
        <>
          <button
            type="button"
            onClick={onSave}
            disabled={busy || !canSave}
            className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
          >
            {busy ? "Saving…" : "Save"}
          </button>
          {" · "}
          <button
            type="button"
            onClick={onCancel}
            disabled={busy}
            className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
          >
            Cancel
          </button>
        </>
      ) : (
        <>
          <button
            type="button"
            onClick={onEdit}
            disabled={busy}
            className="text-xs text-gray-600 hover:text-gray-800 disabled:opacity-50"
          >
            Edit
          </button>
          {" · "}
          <button
            type="button"
            onClick={onDelete}
            disabled={busy}
            className="text-xs text-red-500 hover:text-red-700 disabled:opacity-50"
          >
            Delete
          </button>
        </>
      )}
    </AdminTd>
  );
}

// 行级 Actions 移动端样式：border 按钮（保留 min-h-[40px] 触摸区）
function MobileActions({
  editing,
  busy,
  canSave,
  onSave,
  onCancel,
  onEdit,
  onDelete,
}: {
  editing: boolean;
  busy: boolean;
  canSave: boolean;
  onSave: () => void;
  onCancel: () => void;
  onEdit: () => void;
  onDelete: () => void;
}) {
  return editing ? (
    <>
      <button
        type="button"
        onClick={onSave}
        disabled={busy || !canSave}
        className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-600 hover:bg-blue-100 disabled:opacity-50 min-h-[40px]"
      >
        {busy ? "Saving…" : "Save"}
      </button>
      <button
        type="button"
        onClick={onCancel}
        disabled={busy}
        className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50 min-h-[40px]"
      >
        Cancel
      </button>
    </>
  ) : (
    <>
      <button
        type="button"
        onClick={onEdit}
        disabled={busy}
        className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 min-h-[40px]"
      >
        Edit
      </button>
      <button
        type="button"
        onClick={onDelete}
        disabled={busy}
        className="rounded border border-red-200 px-2 py-1 text-xs text-red-500 hover:bg-red-50 disabled:opacity-50 min-h-[40px]"
      >
        Delete
      </button>
    </>
  );
}

export default function DisplaySettings() {
  const [hiddenRules, setHiddenRules] = useState<HiddenGroupRule[]>([]);
  const [hiddenEditingIdx, setHiddenEditingIdx] = useState<number | null>(null);
  const [hiddenEditName, setHiddenEditName] = useState("");
  const [hiddenEditPatterns, setHiddenEditPatterns] = useState("");
  const [hiddenBusy, setHiddenBusy] = useState(false);
  const [hiddenError, setHiddenError] = useState<string | null>(null);

  const [aliasRules, setAliasRules] = useState<AliasRule[]>([]);
  const [aliasesEditingIdx, setAliasesEditingIdx] = useState<number | null>(null);
  const [aliasesEditName, setAliasesEditName] = useState("");
  const [aliasesEditValues, setAliasesEditValues] = useState("");
  const [aliasesBusy, setAliasesBusy] = useState(false);
  const [aliasesError, setAliasesError] = useState<string | null>(null);

  const [agentRules, setAgentRules] = useState<AgentAliasRule[]>([]);
  const [agentEditingIdx, setAgentEditingIdx] = useState<number | null>(null);
  const [agentEditName, setAgentEditName] = useState("");
  const [agentEditValues, setAgentEditValues] = useState("");
  const [agentAliasesBusy, setAgentAliasesBusy] = useState(false);
  const [agentAliasesError, setAgentAliasesError] = useState<string | null>(null);

  const [observedAgents, setObservedAgents] = useState<ObservedAgentToken[]>([]);
  const [editingObserved, setEditingObserved] = useState<string | null>(null);
  const [editingObservedName, setEditingObservedName] = useState("");

  const [statusConfig, setStatusConfig] = useState<StatusPageConfigData | null>(null);
  const [statusBusy, setStatusBusy] = useState(false);
  const [statusError, setStatusError] = useState<string | null>(null);

  const [hiddenSources, setHiddenSources] = useState<HiddenSourcesData | null>(null);
  const [hiddenSourcesBusy, setHiddenSourcesBusy] = useState(false);
  const [hiddenSourcesError, setHiddenSourcesError] = useState<string | null>(null);

  const [providerOptions, setProviderOptions] = useState<string[]>([]);
  const [agentOptionsRaw, setAgentOptionsRaw] = useState<string[]>([]);

  const load = useCallback(async () => {
    const [res, statusRes, aliasesRes, hsRes, providersRes, agentsRes, agentAliasesRes] = await Promise.all([
      apiFetch("/api/admin/settings/display"),
      apiFetch("/api/admin/settings/status"),
      apiFetch("/api/admin/settings/aliases"),
      apiFetch("/api/admin/settings/hidden-sources"),
      apiFetch("/api/providers?includeHidden=1"),
      apiFetch("/api/agents?dimension=key&includeHidden=1"),
      apiFetch("/api/admin/settings/agent-aliases"),
    ]);
    const json = await res.json();
    const statusJson = await statusRes.json();
    const aliasesJson = await aliasesRes.json();
    const hsJson = await hsRes.json();
    const providersJson = await providersRes.json();
    const agentsJson = await agentsRes.json();
    const agentAliasesJson = await agentAliasesRes.json();
    if (json.success) {
      const d = json.data as DisplayData;
      setHiddenRules(
        d.groups.map((g) => ({ name: g.name, patterns: g.patterns.join(", ") }))
      );
    }
    if (statusJson.success) {
      const d = statusJson.data as { config: StatusPageConfigData };
      setStatusConfig(d.config);
    }
    if (aliasesJson.success) {
      const rules = aliasesJson.data as Array<{ name: string; aliases: string[] }>;
      setAliasRules(rules.map((r) => ({ name: r.name, aliases: r.aliases.join(", ") })));
    }
    if (agentAliasesJson.success) {
      const d = agentAliasesJson.data as {
        rules: Array<{ name: string; aliases: string[] }>;
        observed: ObservedAgentToken[];
      };
      setAgentRules(d.rules.map((r) => ({ name: r.name, aliases: r.aliases.join(", ") })));
      setObservedAgents(Array.isArray(d.observed) ? d.observed : []);
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

  const putSetting = useCallback(async (url: string, payload: object): Promise<PutResult> => {
    try {
      const res = await apiFetch(url, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = await res.json();
      if (json.success) return { ok: true, error: "" };
      return { ok: false, error: json.error || "Failed to save" };
    } catch {
      return { ok: false, error: "Network error" };
    }
  }, []);

  // ---- Hidden provider groups（行编辑）----
  const toHiddenGroups = (rules: HiddenGroupRule[]) =>
    rules
      .filter((r) => !r.pending)
      .map((r) => ({
        name: r.name.trim(),
        patterns: r.patterns
          .split(",")
          .map((p) => p.trim())
          .filter(Boolean),
      }))
      .filter((r) => r.patterns.length > 0);

  const startHiddenEdit = (idx: number) => {
    if (hiddenBusy) return;
    const r = hiddenRules[idx];
    if (!r) return;
    setHiddenEditName(r.name);
    setHiddenEditPatterns(r.patterns);
    setHiddenEditingIdx(idx);
  };

  const addHiddenRow = () => {
    if (hiddenBusy || hiddenEditingIdx !== null) return;
    setHiddenRules((prev) => [...prev, { name: "", patterns: "", pending: true }]);
    setHiddenEditName("");
    setHiddenEditPatterns("");
    setHiddenEditingIdx(hiddenRules.length);
  };

  const cancelHiddenEdit = () => {
    if (hiddenEditingIdx === null) return;
    if (hiddenRules[hiddenEditingIdx]?.pending) {
      setHiddenRules((prev) => prev.filter((_, i) => i !== hiddenEditingIdx));
    }
    setHiddenEditingIdx(null);
  };

  const saveHiddenRow = async () => {
    if (hiddenEditingIdx === null || hiddenBusy) return;
    if (!hiddenEditPatterns.trim()) return;
    const next = hiddenRules.map((r, i) =>
      i === hiddenEditingIdx ? { name: hiddenEditName, patterns: hiddenEditPatterns } : r
    );
    setHiddenBusy(true);
    setHiddenError(null);
    const result = await putSetting("/api/admin/settings/display", {
      groups: toHiddenGroups(next),
    });
    if (result.ok) {
      setHiddenEditingIdx(null);
      await load();
    } else {
      setHiddenError(result.error);
    }
    setHiddenBusy(false);
  };

  const deleteHiddenRow = async (idx: number) => {
    if (hiddenBusy) return;
    const rule = hiddenRules[idx];
    if (!rule) return;
    if (!window.confirm(`Delete group "${rule.name.trim() || "(unnamed)"}"?`)) return;
    setHiddenBusy(true);
    setHiddenError(null);
    const result = await putSetting("/api/admin/settings/display", {
      groups: toHiddenGroups(hiddenRules.filter((_, i) => i !== idx)),
    });
    if (result.ok) {
      setHiddenEditingIdx(null);
      await load();
    } else {
      setHiddenError(result.error);
    }
    setHiddenBusy(false);
  };

  // ---- Model Aliases（行编辑）----
  const toAliasRules = (rules: AliasRule[]) =>
    rules
      .filter((r) => !r.pending)
      .map((r) => ({
        name: r.name.trim(),
        aliases: r.aliases
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
      }))
      .filter((r) => r.name !== "");

  const startAliasEdit = (idx: number) => {
    if (aliasesBusy) return;
    const r = aliasRules[idx];
    if (!r) return;
    setAliasesEditName(r.name);
    setAliasesEditValues(r.aliases);
    setAliasesEditingIdx(idx);
  };

  const addAliasRow = () => {
    if (aliasesBusy || aliasesEditingIdx !== null) return;
    setAliasRules((prev) => [...prev, { name: "", aliases: "", pending: true }]);
    setAliasesEditName("");
    setAliasesEditValues("");
    setAliasesEditingIdx(aliasRules.length);
  };

  const cancelAliasEdit = () => {
    if (aliasesEditingIdx === null) return;
    if (aliasRules[aliasesEditingIdx]?.pending) {
      setAliasRules((prev) => prev.filter((_, i) => i !== aliasesEditingIdx));
    }
    setAliasesEditingIdx(null);
  };

  const saveAliasRow = async () => {
    if (aliasesEditingIdx === null || aliasesBusy) return;
    if (!aliasesEditName.trim()) return;
    const next = aliasRules.map((r, i) =>
      i === aliasesEditingIdx ? { name: aliasesEditName, aliases: aliasesEditValues } : r
    );
    setAliasesBusy(true);
    setAliasesError(null);
    const result = await putSetting("/api/admin/settings/aliases", {
      rules: toAliasRules(next),
    });
    if (result.ok) {
      setAliasesEditingIdx(null);
      await load();
    } else {
      setAliasesError(result.error);
    }
    setAliasesBusy(false);
  };

  const deleteAliasRow = async (idx: number) => {
    if (aliasesBusy) return;
    const rule = aliasRules[idx];
    if (!rule) return;
    if (!window.confirm(`Delete alias group "${rule.name.trim() || "(unnamed)"}"?`)) return;
    setAliasesBusy(true);
    setAliasesError(null);
    const result = await putSetting("/api/admin/settings/aliases", {
      rules: toAliasRules(aliasRules.filter((_, i) => i !== idx)),
    });
    if (result.ok) {
      setAliasesEditingIdx(null);
      await load();
    } else {
      setAliasesError(result.error);
    }
    setAliasesBusy(false);
  };

  // ---- Agent Aliases（行编辑）----
  const toAgentAliasRules = (rules: AgentAliasRule[]) =>
    rules
      .filter((r) => !r.pending)
      .map((r) => ({
        name: r.name.trim(),
        aliases: r.aliases
          .split(",")
          .map((a) => a.trim())
          .filter(Boolean),
      }))
      .filter((r) => r.name !== "");

  const startAgentEdit = (idx: number) => {
    if (agentAliasesBusy) return;
    const r = agentRules[idx];
    if (!r) return;
    setAgentEditName(r.name);
    setAgentEditValues(r.aliases);
    setAgentEditingIdx(idx);
  };

  const addAgentRow = () => {
    if (agentAliasesBusy || agentEditingIdx !== null) return;
    setAgentRules((prev) => [...prev, { name: "", aliases: "", pending: true }]);
    setAgentEditName("");
    setAgentEditValues("");
    setAgentEditingIdx(agentRules.length);
  };

  const cancelAgentEdit = () => {
    if (agentEditingIdx === null) return;
    if (agentRules[agentEditingIdx]?.pending) {
      setAgentRules((prev) => prev.filter((_, i) => i !== agentEditingIdx));
    }
    setAgentEditingIdx(null);
  };

  const saveAgentRow = async () => {
    if (agentEditingIdx === null || agentAliasesBusy) return;
    if (!agentEditName.trim()) return;
    const next = agentRules.map((r, i) =>
      i === agentEditingIdx ? { name: agentEditName, aliases: agentEditValues } : r
    );
    setAgentAliasesBusy(true);
    setAgentAliasesError(null);
    const result = await putSetting("/api/admin/settings/agent-aliases", {
      rules: toAgentAliasRules(next),
    });
    if (result.ok) {
      setAgentEditingIdx(null);
      await load();
    } else {
      setAgentAliasesError(result.error);
    }
    setAgentAliasesBusy(false);
  };

  const deleteAgentRow = async (idx: number) => {
    if (agentAliasesBusy) return;
    const rule = agentRules[idx];
    if (!rule) return;
    if (!window.confirm(`Delete agent alias group "${rule.name.trim() || "(unnamed)"}"?`)) return;
    setAgentAliasesBusy(true);
    setAgentAliasesError(null);
    const result = await putSetting("/api/admin/settings/agent-aliases", {
      rules: toAgentAliasRules(agentRules.filter((_, i) => i !== idx)),
    });
    if (result.ok) {
      setAgentEditingIdx(null);
      await load();
    } else {
      setAgentAliasesError(result.error);
    }
    setAgentAliasesBusy(false);
  };

  // 把已观测 UA token 采纳为手动规则并立即持久化（无整块 Save）：
  // token 已在某手动行 aliases 中 → 更新该行 name；同名手动行存在 → 追加 token；
  // 否则新增一行。PUT 成功后 load() 刷新规则与 observed 列表。
  const adoptObservedAgent = async (token: string, name: string) => {
    const trimmed = name.trim();
    if (!trimmed || agentAliasesBusy) return;
    const base =
      agentEditingIdx !== null
        ? agentRules.map((r, i) =>
            i === agentEditingIdx ? { name: agentEditName, aliases: agentEditValues } : r
          )
        : agentRules;
    const tokenLc = token.toLowerCase();
    let rules = base.map((r) => ({ ...r }));
    const tokenRow = rules.findIndex((r) =>
      r.aliases
        .split(",")
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean)
        .includes(tokenLc)
    );
    if (tokenRow >= 0) {
      rules[tokenRow] = { ...rules[tokenRow], name: trimmed };
    } else {
      const nameRow = rules.findIndex(
        (r) => r.name.trim().toLowerCase() === trimmed.toLowerCase()
      );
      if (nameRow >= 0) {
        rules[nameRow] = {
          ...rules[nameRow],
          aliases: rules[nameRow].aliases ? `${rules[nameRow].aliases}, ${token}` : token,
        };
      } else {
        rules = [...rules, { name: trimmed, aliases: token }];
      }
    }
    setAgentAliasesBusy(true);
    setAgentAliasesError(null);
    const result = await putSetting("/api/admin/settings/agent-aliases", {
      rules: toAgentAliasRules(rules),
    });
    if (result.ok) {
      setEditingObserved(null);
      setAgentEditingIdx(null);
      await load();
    } else {
      setAgentAliasesError(result.error);
    }
    setAgentAliasesBusy(false);
  };

  // ---- Public Status Page：勾选即保存（乐观更新 + 失败回滚 + in-flight 锁）----
  const applyStatusConfig = async (
    mutate: (prev: StatusPageConfigData) => StatusPageConfigData
  ) => {
    if (!statusConfig || statusBusy) return;
    const prev = statusConfig;
    const next = mutate(prev);
    setStatusConfig(next);
    setStatusBusy(true);
    setStatusError(null);
    const result = await putSetting("/api/admin/settings/status", { config: next });
    if (!result.ok) {
      setStatusError(result.error);
      setStatusConfig(prev);
    }
    setStatusBusy(false);
  };

  const toggleStatusEnabled = () => {
    void applyStatusConfig((prev) => ({ ...prev, enabled: !prev.enabled }));
  };

  const toggleStatusElement = (key: keyof StatusPageElementsData) => {
    void applyStatusConfig((prev) => ({
      ...prev,
      elements: { ...prev.elements, [key]: !prev.elements[key] },
    }));
  };

  // ---- Hidden Sources：勾选即保存（乐观更新 + 失败回滚 + in-flight 锁）----
  const applyHiddenSources = async (
    mutate: (prev: HiddenSourcesData) => HiddenSourcesData
  ) => {
    if (!hiddenSources || hiddenSourcesBusy) return;
    const prev = hiddenSources;
    const next = mutate(prev);
    setHiddenSources(next);
    setHiddenSourcesBusy(true);
    setHiddenSourcesError(null);
    const result = await putSetting("/api/admin/settings/hidden-sources", { config: next });
    if (!result.ok) {
      setHiddenSourcesError(result.error);
      setHiddenSources(prev);
    }
    setHiddenSourcesBusy(false);
  };

  const toggleHiddenSource = (field: "upstreams" | "virtualKeys", name: string) => {
    void applyHiddenSources((prev) => {
      const list = prev[field];
      const next = list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
      return { ...prev, [field]: next };
    });
  };

  const toggleExcludedSource = (
    field: "excludedUpstreams" | "excludedVirtualKeys",
    name: string
  ) => {
    void applyHiddenSources((prev) => {
      const list = prev[field];
      const next = list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
      return { ...prev, [field]: next };
    });
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
        Provider anonymization (hidden provider groups).
      </p>

      <label className="mb-1 block text-sm font-medium text-gray-700">
        Hidden provider groups
      </label>
      <AdminTable>
        <AdminTableHead
          columns={[
            { label: "Group name" },
            { label: "Patterns" },
            { label: "Actions", align: "right" },
          ]}
        />
        <AdminTableBody>
          {hiddenRules.map((rule, idx) => {
            const editing = hiddenEditingIdx === idx;
            return (
              <tr key={idx}>
                <AdminTd>
                  {editing ? (
                    <input
                      value={hiddenEditName}
                      onChange={(e) => setHiddenEditName(e.target.value)}
                      placeholder="Display name (empty = Provider A, B, C...)"
                      className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                    />
                  ) : (
                    <span className="text-sm text-gray-900">
                      {rule.name || <span className="text-gray-400">(unnamed)</span>}
                    </span>
                  )}
                </AdminTd>
                <AdminTd>
                  {editing ? (
                    <input
                      value={hiddenEditPatterns}
                      onChange={(e) => setHiddenEditPatterns(e.target.value)}
                      placeholder="patterns, comma separated (e.g. vendor*, vendor-partner)"
                      spellCheck={false}
                      className="w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none"
                    />
                  ) : (
                    <span className="font-mono text-xs text-gray-600 break-all">{rule.patterns}</span>
                  )}
                </AdminTd>
                <DesktopActions
                  editing={editing}
                  busy={hiddenBusy}
                  canSave={hiddenEditPatterns.trim().length > 0}
                  onSave={saveHiddenRow}
                  onCancel={cancelHiddenEdit}
                  onEdit={() => startHiddenEdit(idx)}
                  onDelete={() => deleteHiddenRow(idx)}
                />
              </tr>
            );
          })}
          {hiddenRules.length === 0 && (
            <AdminTableEmptyRow colSpan={3}>No hidden provider groups configured.</AdminTableEmptyRow>
          )}
        </AdminTableBody>
      </AdminTable>
      <AdminMobileCards>
        {hiddenRules.map((rule, idx) => {
          const editing = hiddenEditingIdx === idx;
          return (
            <AdminMobileCard key={idx}>
              <div className="flex justify-between items-start gap-2 mb-3">
                <div className="min-w-0 flex-1">
                  <p className="text-xs text-gray-500">Group name</p>
                  {editing ? (
                    <input
                      value={hiddenEditName}
                      onChange={(e) => setHiddenEditName(e.target.value)}
                      placeholder="Display name (empty = Provider A, B, C...)"
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                    />
                  ) : (
                    <p className="mt-0.5 text-sm text-gray-900">
                      {rule.name || <span className="text-gray-400">(unnamed)</span>}
                    </p>
                  )}
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <MobileActions
                    editing={editing}
                    busy={hiddenBusy}
                    canSave={hiddenEditPatterns.trim().length > 0}
                    onSave={saveHiddenRow}
                    onCancel={cancelHiddenEdit}
                    onEdit={() => startHiddenEdit(idx)}
                    onDelete={() => deleteHiddenRow(idx)}
                  />
                </div>
              </div>
              <div>
                <p className="text-xs text-gray-500">Patterns</p>
                {editing ? (
                  <input
                    value={hiddenEditPatterns}
                    onChange={(e) => setHiddenEditPatterns(e.target.value)}
                    placeholder="patterns, comma separated (e.g. vendor*, vendor-partner)"
                    spellCheck={false}
                    className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-sm focus:border-blue-500 focus:outline-none"
                  />
                ) : (
                  <p className="mt-0.5 font-mono text-xs text-gray-600 break-all">{rule.patterns}</p>
                )}
              </div>
            </AdminMobileCard>
          );
        })}
        {hiddenRules.length === 0 && (
          <AdminMobileEmpty>No hidden provider groups configured.</AdminMobileEmpty>
        )}
      </AdminMobileCards>
      <button
        type="button"
        onClick={addHiddenRow}
        disabled={hiddenEditingIdx !== null}
        className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
      >
        + Add row
      </button>
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

        <AdminTable>
          <AdminTableHead
            columns={[
              { label: "Group name" },
              { label: "Aliases" },
              { label: "Actions", align: "right" },
            ]}
          />
          <AdminTableBody>
            {aliasRules.map((rule, idx) => {
              const editing = aliasesEditingIdx === idx;
              return (
                <tr key={idx}>
                  <AdminTd>
                    {editing ? (
                      <input
                        value={aliasesEditName}
                        onChange={(e) => setAliasesEditName(e.target.value)}
                        placeholder="Group name (e.g. Claude Sonnet 4.6)"
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                      />
                    ) : (
                      <span className="text-sm text-gray-900">
                        {rule.name || <span className="text-gray-400">(unnamed)</span>}
                      </span>
                    )}
                  </AdminTd>
                  <AdminTd>
                    {editing ? (
                      <input
                        value={aliasesEditValues}
                        onChange={(e) => setAliasesEditValues(e.target.value)}
                        placeholder="aliases, comma separated (e.g. claude-sonnet-4-6, anthropic/claude-sonnet-4-6)"
                        spellCheck={false}
                        className="w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none"
                      />
                    ) : (
                      <span className="font-mono text-xs text-gray-600 break-all">{rule.aliases}</span>
                    )}
                  </AdminTd>
                  <DesktopActions
                    editing={editing}
                    busy={aliasesBusy}
                    canSave={aliasesEditName.trim().length > 0}
                    onSave={saveAliasRow}
                    onCancel={cancelAliasEdit}
                    onEdit={() => startAliasEdit(idx)}
                    onDelete={() => deleteAliasRow(idx)}
                  />
                </tr>
              );
            })}
            {aliasRules.length === 0 && (
              <AdminTableEmptyRow colSpan={3}>No alias groups configured.</AdminTableEmptyRow>
            )}
          </AdminTableBody>
        </AdminTable>
        <AdminMobileCards>
          {aliasRules.map((rule, idx) => {
            const editing = aliasesEditingIdx === idx;
            return (
              <AdminMobileCard key={idx}>
                <div className="flex justify-between items-start gap-2 mb-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-gray-500">Group name</p>
                    {editing ? (
                      <input
                        value={aliasesEditName}
                        onChange={(e) => setAliasesEditName(e.target.value)}
                        placeholder="Group name (e.g. Claude Sonnet 4.6)"
                        className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                      />
                    ) : (
                      <p className="mt-0.5 text-sm text-gray-900">
                        {rule.name || <span className="text-gray-400">(unnamed)</span>}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <MobileActions
                      editing={editing}
                      busy={aliasesBusy}
                      canSave={aliasesEditName.trim().length > 0}
                      onSave={saveAliasRow}
                      onCancel={cancelAliasEdit}
                      onEdit={() => startAliasEdit(idx)}
                      onDelete={() => deleteAliasRow(idx)}
                    />
                  </div>
                </div>
                <div>
                  <p className="text-xs text-gray-500">Aliases</p>
                  {editing ? (
                    <input
                      value={aliasesEditValues}
                      onChange={(e) => setAliasesEditValues(e.target.value)}
                      placeholder="aliases, comma separated (e.g. claude-sonnet-4-6, anthropic/claude-sonnet-4-6)"
                      spellCheck={false}
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-sm focus:border-blue-500 focus:outline-none"
                    />
                  ) : (
                    <p className="mt-0.5 font-mono text-xs text-gray-600 break-all">{rule.aliases}</p>
                  )}
                </div>
              </AdminMobileCard>
            );
          })}
          {aliasRules.length === 0 && (
            <AdminMobileEmpty>No alias groups configured.</AdminMobileEmpty>
          )}
        </AdminMobileCards>
        <button
          type="button"
          onClick={addAliasRow}
          disabled={aliasesEditingIdx !== null}
          className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          + Add row
        </button>

        {aliasesError && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {aliasesError}
          </div>
        )}
      </div>

      <div className="mt-8 border-t border-gray-100 pt-6">
        <h3 className="mb-1 text-base font-semibold text-gray-900">
          Agent Aliases
        </h3>
        <p className="mb-4 text-sm text-gray-500">
          Map client user-agents to a display name for the Agent dimension.
          Each row: a display name and comma-separated UA tokens (the text
          before the first <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">/</code> in
          the user agent, e.g.{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">claude-cli</code>{" "}
          from <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">claude-cli/2.1.5 (external, cli)</code>).
          Matching is case-insensitive and manual aliases take priority over
          the built-in mapping. Records with no user agent are shown as{" "}
          {"(unknown)"}.
        </p>

        <AdminTable>
          <AdminTableHead
            columns={[
              { label: "Display name" },
              { label: "UA tokens" },
              { label: "Actions", align: "right" },
            ]}
          />
          <AdminTableBody>
            {agentRules.map((rule, idx) => {
              const editing = agentEditingIdx === idx;
              return (
                <tr key={idx}>
                  <AdminTd>
                    {editing ? (
                      <input
                        value={agentEditName}
                        onChange={(e) => setAgentEditName(e.target.value)}
                        placeholder="Display name (e.g. Claude Code)"
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                      />
                    ) : (
                      <span className="text-sm text-gray-900">
                        {rule.name || <span className="text-gray-400">(unnamed)</span>}
                      </span>
                    )}
                  </AdminTd>
                  <AdminTd>
                    {editing ? (
                      <input
                        value={agentEditValues}
                        onChange={(e) => setAgentEditValues(e.target.value)}
                        placeholder="UA tokens, comma separated (e.g. claude-cli, claude-code-cli)"
                        spellCheck={false}
                        className="w-full rounded border border-gray-300 px-2 py-1 font-mono text-xs focus:border-blue-500 focus:outline-none"
                      />
                    ) : (
                      <span className="font-mono text-xs text-gray-600 break-all">{rule.aliases}</span>
                    )}
                  </AdminTd>
                  <DesktopActions
                    editing={editing}
                    busy={agentAliasesBusy}
                    canSave={agentEditName.trim().length > 0}
                    onSave={saveAgentRow}
                    onCancel={cancelAgentEdit}
                    onEdit={() => startAgentEdit(idx)}
                    onDelete={() => deleteAgentRow(idx)}
                  />
                </tr>
              );
            })}
            {agentRules.length === 0 && (
              <AdminTableEmptyRow colSpan={3}>No agent alias groups configured.</AdminTableEmptyRow>
            )}
          </AdminTableBody>
        </AdminTable>
        <AdminMobileCards>
          {agentRules.map((rule, idx) => {
            const editing = agentEditingIdx === idx;
            return (
              <AdminMobileCard key={idx}>
                <div className="flex justify-between items-start gap-2 mb-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-xs text-gray-500">Display name</p>
                    {editing ? (
                      <input
                        value={agentEditName}
                        onChange={(e) => setAgentEditName(e.target.value)}
                        placeholder="Display name (e.g. Claude Code)"
                        className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none"
                      />
                    ) : (
                      <p className="mt-0.5 text-sm text-gray-900">
                        {rule.name || <span className="text-gray-400">(unnamed)</span>}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 items-center gap-2">
                    <MobileActions
                      editing={editing}
                      busy={agentAliasesBusy}
                      canSave={agentEditName.trim().length > 0}
                      onSave={saveAgentRow}
                      onCancel={cancelAgentEdit}
                      onEdit={() => startAgentEdit(idx)}
                      onDelete={() => deleteAgentRow(idx)}
                    />
                  </div>
                </div>
                <div>
                  <p className="text-xs text-gray-500">UA tokens</p>
                  {editing ? (
                    <input
                      value={agentEditValues}
                      onChange={(e) => setAgentEditValues(e.target.value)}
                      placeholder="UA tokens, comma separated (e.g. claude-cli, claude-code-cli)"
                      spellCheck={false}
                      className="mt-1 w-full rounded border border-gray-300 px-2 py-1.5 font-mono text-sm focus:border-blue-500 focus:outline-none"
                    />
                  ) : (
                    <p className="mt-0.5 font-mono text-xs text-gray-600 break-all">{rule.aliases}</p>
                  )}
                </div>
              </AdminMobileCard>
            );
          })}
          {agentRules.length === 0 && (
            <AdminMobileEmpty>No agent alias groups configured.</AdminMobileEmpty>
          )}
        </AdminMobileCards>
        <button
          type="button"
          onClick={addAgentRow}
          disabled={agentEditingIdx !== null}
          className="rounded border border-gray-300 px-3 py-2 text-sm text-gray-600 hover:bg-gray-50 disabled:opacity-50"
        >
          + Add row
        </button>

        <div className="mt-6">
          <h4 className="mb-1 text-sm font-medium text-gray-700">
            Observed user agents
          </h4>
          <p className="mb-3 text-xs text-gray-400">
            UA tokens seen in your records and how each resolves.{" "}
            <span className="rounded bg-blue-50 px-1.5 py-0.5 text-blue-600">manual</span>{" "}
            = matched a rule above,{" "}
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-500">built-in</span>{" "}
            = automatic known-tool mapping,{" "}
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-gray-400">as-is</span>{" "}
            = shown unchanged.
          </p>
          <AdminTable>
            <AdminTableHead
              columns={[
                { label: "UA token" },
                { label: "Agent" },
                { label: "Source", align: "right" },
              ]}
            />
            <AdminTableBody>
              {observedAgents.map((o) => (
                <tr key={o.token}>
                  <AdminTd>
                    <code className="font-mono text-xs text-gray-600 break-all">{o.token}</code>
                  </AdminTd>
                  <AdminTd>
                    {editingObserved === o.token ? (
                      <input
                        value={editingObservedName}
                        onChange={(e) => setEditingObservedName(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === "Enter") adoptObservedAgent(o.token, editingObservedName);
                          if (e.key === "Escape") setEditingObserved(null);
                        }}
                        placeholder="Display name"
                        autoFocus
                        className="w-full rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none"
                      />
                    ) : (
                      <span className="text-sm text-gray-600">{o.name}</span>
                    )}
                  </AdminTd>
                  <AdminTd align="right" className="whitespace-nowrap">
                    {editingObserved === o.token ? (
                      <>
                        <button
                          type="button"
                          onClick={() => adoptObservedAgent(o.token, editingObservedName)}
                          disabled={agentAliasesBusy || !editingObservedName.trim()}
                          className="text-xs font-medium text-blue-600 hover:text-blue-800 disabled:opacity-50"
                        >
                          {agentAliasesBusy ? "Saving…" : "Apply"}
                        </button>
                        {" · "}
                        <button
                          type="button"
                          onClick={() => setEditingObserved(null)}
                          disabled={agentAliasesBusy}
                          className="text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50"
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <div className="flex items-center justify-end gap-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${
                            o.source === "manual"
                              ? "bg-blue-50 text-blue-600"
                              : o.source === "builtin"
                                ? "bg-gray-100 text-gray-500"
                                : "bg-gray-100 text-gray-400"
                          }`}
                        >
                          {o.source}
                        </span>
                        {o.source !== "manual" && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingObserved(o.token);
                              setEditingObservedName(o.name);
                            }}
                            disabled={agentAliasesBusy}
                            className="text-xs text-gray-600 hover:text-gray-800 disabled:opacity-50"
                          >
                            Edit
                          </button>
                        )}
                      </div>
                    )}
                  </AdminTd>
                </tr>
              ))}
              {observedAgents.length === 0 && (
                <AdminTableEmptyRow colSpan={3}>No user agents recorded yet.</AdminTableEmptyRow>
              )}
            </AdminTableBody>
          </AdminTable>
          <AdminMobileCards>
            {observedAgents.map((o) => (
              <AdminMobileCard key={o.token}>
                {editingObserved === o.token ? (
                  <>
                    <input
                      value={editingObservedName}
                      onChange={(e) => setEditingObservedName(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") adoptObservedAgent(o.token, editingObservedName);
                        if (e.key === "Escape") setEditingObserved(null);
                      }}
                      placeholder="Display name"
                      autoFocus
                      className="w-full rounded border border-gray-300 px-2 py-1.5 text-base focus:border-blue-500 focus:outline-none"
                    />
                    <div className="mt-2 flex gap-2">
                      <button
                        type="button"
                        onClick={() => adoptObservedAgent(o.token, editingObservedName)}
                        disabled={agentAliasesBusy || !editingObservedName.trim()}
                        className="rounded border border-blue-200 bg-blue-50 px-2 py-1 text-xs text-blue-600 hover:bg-blue-100 disabled:opacity-50 min-h-[40px]"
                      >
                        {agentAliasesBusy ? "Saving…" : "Apply"}
                      </button>
                      <button
                        type="button"
                        onClick={() => setEditingObserved(null)}
                        disabled={agentAliasesBusy}
                        className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-500 hover:bg-gray-100 disabled:opacity-50 min-h-[40px]"
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="flex items-start justify-between gap-2">
                      <code className="min-w-0 font-mono text-xs text-gray-600 break-all">{o.token}</code>
                      <div className="flex shrink-0 items-center gap-2">
                        <span
                          className={`rounded px-1.5 py-0.5 text-xs ${
                            o.source === "manual"
                              ? "bg-blue-50 text-blue-600"
                              : o.source === "builtin"
                                ? "bg-gray-100 text-gray-500"
                                : "bg-gray-100 text-gray-400"
                          }`}
                        >
                          {o.source}
                        </span>
                        {o.source !== "manual" && (
                          <button
                            type="button"
                            onClick={() => {
                              setEditingObserved(o.token);
                              setEditingObservedName(o.name);
                            }}
                            disabled={agentAliasesBusy}
                            className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-600 hover:bg-gray-100 disabled:opacity-50 min-h-[40px]"
                          >
                            Edit
                          </button>
                        )}
                      </div>
                    </div>
                    <p className="mt-1 text-sm text-gray-600">{o.name}</p>
                  </>
                )}
              </AdminMobileCard>
            ))}
            {observedAgents.length === 0 && (
              <AdminMobileEmpty>No user agents recorded yet.</AdminMobileEmpty>
            )}
          </AdminMobileCards>
          <p className="text-xs text-gray-400">
            Editing a built-in or as-is row adds it to the manual rules above;
            changes apply immediately.
          </p>
        </div>

        {agentAliasesError && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {agentAliasesError}
          </div>
        )}
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
                onChange={toggleStatusEnabled}
                disabled={statusBusy}
                className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
              />
              <span className="text-sm font-medium text-gray-700">
                Enable public status page
              </span>
            </label>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                Elements
              </p>
              <AdminTable>
                <AdminTableHead
                  columns={[
                    { label: "Element" },
                    { label: "Enabled", align: "right" },
                  ]}
                />
                <AdminTableBody>
                  {STATUS_ELEMENT_LABELS.map(({ key, label, hint }) => (
                    <tr key={key}>
                      <AdminTd>
                        <span className="block text-sm font-medium text-gray-700">
                          {label}
                        </span>
                        {hint && (
                          <span className="block text-xs text-gray-400">
                            {hint}
                          </span>
                        )}
                      </AdminTd>
                      <AdminTd align="right">
                        <input
                          type="checkbox"
                          checked={statusConfig.elements[key]}
                          onChange={() => toggleStatusElement(key)}
                          disabled={statusBusy}
                          className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                        />
                      </AdminTd>
                    </tr>
                  ))}
                </AdminTableBody>
              </AdminTable>
              <AdminMobileCards>
                {STATUS_ELEMENT_LABELS.map(({ key, label, hint }) => (
                  <AdminMobileCard key={key}>
                    <label className="flex items-center gap-3 min-h-[40px] cursor-pointer">
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-medium text-gray-700">
                          {label}
                        </span>
                        {hint && (
                          <span className="block text-xs text-gray-400">
                            {hint}
                          </span>
                        )}
                      </span>
                      <input
                        type="checkbox"
                        checked={statusConfig.elements[key]}
                        onChange={() => toggleStatusElement(key)}
                        disabled={statusBusy}
                        className="h-5 w-5 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                      />
                    </label>
                  </AdminMobileCard>
                ))}
              </AdminMobileCards>
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
              <AdminTable>
                <AdminTableHead
                  columns={[
                    { label: "Upstream" },
                    { label: "Hide", align: "right" },
                    { label: "Exclude", align: "right" },
                  ]}
                />
                <AdminTableBody>
                  {upstreamOptions(hiddenSources).map((name) => {
                    const hidden = hiddenSources.upstreams.includes(name);
                    const excluded = hiddenSources.excludedUpstreams.includes(name);
                    return (
                      <tr key={name}>
                        <AdminTd>
                          <span className="block truncate text-sm font-medium text-gray-700" title={name}>
                            {name}
                          </span>
                          <span className="block text-xs text-gray-400">
                            {excluded ? "Excluded from totals" : "Counted in totals"}
                          </span>
                        </AdminTd>
                        <AdminTd align="right">
                          <input
                            type="checkbox"
                            checked={hidden}
                            onChange={() => toggleHiddenSource("upstreams", name)}
                            disabled={hiddenSourcesBusy}
                            className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                          />
                        </AdminTd>
                        <AdminTd align="right">
                          <input
                            type="checkbox"
                            checked={excluded}
                            onChange={() => toggleExcludedSource("excludedUpstreams", name)}
                            disabled={hiddenSourcesBusy}
                            className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                          />
                        </AdminTd>
                      </tr>
                    );
                  })}
                  {upstreamOptions(hiddenSources).length === 0 && (
                    <AdminTableEmptyRow colSpan={3}>No providers with records yet.</AdminTableEmptyRow>
                  )}
                </AdminTableBody>
              </AdminTable>
              <AdminMobileCards>
                {upstreamOptions(hiddenSources).map((name) => {
                  const hidden = hiddenSources.upstreams.includes(name);
                  const excluded = hiddenSources.excludedUpstreams.includes(name);
                  return (
                    <AdminMobileCard key={name}>
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-gray-700" title={name}>
                            {name}
                          </span>
                          <span className="block text-xs text-gray-400">
                            {excluded ? "Excluded from totals" : "Counted in totals"}
                          </span>
                        </div>
                        <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={hidden}
                            onChange={() => toggleHiddenSource("upstreams", name)}
                            disabled={hiddenSourcesBusy}
                            className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                          />
                          <span className="text-xs text-gray-500">Hide</span>
                        </label>
                        <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={excluded}
                            onChange={() => toggleExcludedSource("excludedUpstreams", name)}
                            disabled={hiddenSourcesBusy}
                            className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                          />
                          <span className="text-xs text-gray-500">Exclude</span>
                        </label>
                      </div>
                    </AdminMobileCard>
                  );
                })}
                {upstreamOptions(hiddenSources).length === 0 && (
                  <AdminMobileEmpty>No providers with records yet.</AdminMobileEmpty>
                )}
              </AdminMobileCards>
            </div>

            <div>
              <p className="mb-2 text-xs font-medium uppercase tracking-wide text-gray-500">
                Virtual Keys
              </p>
              <AdminTable>
                <AdminTableHead
                  columns={[
                    { label: "Virtual Key" },
                    { label: "Hide", align: "right" },
                    { label: "Exclude", align: "right" },
                  ]}
                />
                <AdminTableBody>
                  {agentOptions(hiddenSources).map((name) => {
                    const hidden = hiddenSources.virtualKeys.includes(name);
                    const excluded = hiddenSources.excludedVirtualKeys.includes(name);
                    return (
                      <tr key={name}>
                        <AdminTd>
                          <span className="block truncate text-sm font-medium text-gray-700" title={name}>
                            {name}
                          </span>
                          <span className="block text-xs text-gray-400">
                            {excluded ? "Excluded from totals" : "Counted in totals"}
                          </span>
                        </AdminTd>
                        <AdminTd align="right">
                          <input
                            type="checkbox"
                            checked={hidden}
                            onChange={() => toggleHiddenSource("virtualKeys", name)}
                            disabled={hiddenSourcesBusy}
                            className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                          />
                        </AdminTd>
                        <AdminTd align="right">
                          <input
                            type="checkbox"
                            checked={excluded}
                            onChange={() => toggleExcludedSource("excludedVirtualKeys", name)}
                            disabled={hiddenSourcesBusy}
                            className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                          />
                        </AdminTd>
                      </tr>
                    );
                  })}
                  {agentOptions(hiddenSources).length === 0 && (
                    <AdminTableEmptyRow colSpan={3}>No virtual keys with records yet.</AdminTableEmptyRow>
                  )}
                </AdminTableBody>
              </AdminTable>
              <AdminMobileCards>
                {agentOptions(hiddenSources).map((name) => {
                  const hidden = hiddenSources.virtualKeys.includes(name);
                  const excluded = hiddenSources.excludedVirtualKeys.includes(name);
                  return (
                    <AdminMobileCard key={name}>
                      <div className="flex items-center gap-3">
                        <div className="min-w-0 flex-1">
                          <span className="block truncate text-sm font-medium text-gray-700" title={name}>
                            {name}
                          </span>
                          <span className="block text-xs text-gray-400">
                            {excluded ? "Excluded from totals" : "Counted in totals"}
                          </span>
                        </div>
                        <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={hidden}
                            onChange={() => toggleHiddenSource("virtualKeys", name)}
                            disabled={hiddenSourcesBusy}
                            className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                          />
                          <span className="text-xs text-gray-500">Hide</span>
                        </label>
                        <label className="flex shrink-0 cursor-pointer items-center gap-1.5">
                          <input
                            type="checkbox"
                            checked={excluded}
                            onChange={() => toggleExcludedSource("excludedVirtualKeys", name)}
                            disabled={hiddenSourcesBusy}
                            className="h-5 w-5 rounded border-gray-300 text-blue-600 focus:ring-blue-500 disabled:opacity-50"
                          />
                          <span className="text-xs text-gray-500">Exclude</span>
                        </label>
                      </div>
                    </AdminMobileCard>
                  );
                })}
                {agentOptions(hiddenSources).length === 0 && (
                  <AdminMobileEmpty>No virtual keys with records yet.</AdminMobileEmpty>
                )}
              </AdminMobileCards>
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
          </div>
        )}
      </div>
    </div>
  );
}