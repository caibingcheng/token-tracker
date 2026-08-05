"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import { PROVIDER_PRESETS } from "@/lib/provider-presets";
import UpstreamModelsManager from "./UpstreamModelsManager";

export interface UpstreamItem {
  id: number;
  name: string;
  protocol: string;
  baseUrl: string;
  enabledModels: string[];
  priority: number;
  enabled: boolean;
  keyCount: number;
  balance: string | null;
  balanceUpdatedAt: string | null;
  createdAt: string;
}

export interface UpstreamKeyItem {
  id: number;
  upstreamId: number;
  maskedKey: string;
  enabled: boolean;
  lastStatus: string | null;
  createdAt: string;
}

const PROTOCOLS = ["openai", "anthropic", "gemini"];

interface FormState {
  name: string;
  protocol: string;
  baseUrl: string;
  enabledModels: string;
  priority: string;
}

const EMPTY_FORM: FormState = { name: "", protocol: "openai", baseUrl: "", enabledModels: "", priority: "0" };

interface FormKeyTestResult {
  ok: boolean;
  status: number;
  error?: string;
}

interface ModelPickerState {
  models: string[];
  selected: Set<string>;
  error?: string;
}

export default function UpstreamsPanel() {
  const [upstreams, setUpstreams] = useState<UpstreamItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formKeys, setFormKeys] = useState<string[]>([""]);
  const [formKeyTests, setFormKeyTests] = useState<Record<number, FormKeyTestResult | null>>({});
  const [modelPicker, setModelPicker] = useState<ModelPickerState | null>(null);
  const [fetchingModels, setFetchingModels] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const [keysByUpstream, setKeysByUpstream] = useState<Record<number, UpstreamKeyItem[]>>({});
  const [expandedKeys, setExpandedKeys] = useState<Record<number, boolean>>({});
  const [expanded, setExpanded] = useState<Record<number, boolean>>({});
  const [newKeyInput, setNewKeyInput] = useState<Record<number, string>>({});
  const [balanceInput, setBalanceInput] = useState<Record<number, string>>({});
  const [refreshingBalance, setRefreshingBalance] = useState<Record<number, boolean>>({});
  const [showPresets, setShowPresets] = useState(false);
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; modelCount?: number; error?: string } | null>>({});

  const filteredPresets = useMemo(() => {
    const query = form.name.trim().toLowerCase();
    if (!query) return PROVIDER_PRESETS;
    return PROVIDER_PRESETS.filter((p) => p.name.toLowerCase().includes(query));
  }, [form.name]);

  const loadUpstreams = useCallback(async () => {
    try {
      const res = await apiFetch("/api/admin/upstreams");
      const json = await res.json();
      if (json.success) {
        setUpstreams(json.data);
      } else {
        setError(json.error || "Failed to load upstreams");
      }
    } catch {
      setError("Network error");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUpstreams();
  }, [loadUpstreams]);

  const loadKeys = useCallback(async (upstreamId: number) => {
    const res = await apiFetch(`/api/admin/upstreams/${upstreamId}/keys`);
    const json = await res.json();
    if (json.success) {
      setKeysByUpstream((prev) => ({ ...prev, [upstreamId]: json.data }));
    }
  }, []);

  const toggleKeys = (id: number) => {
    const next = { ...expandedKeys, [id]: !expandedKeys[id] };
    setExpandedKeys(next);
    if (next[id] && !keysByUpstream[id]) {
      loadKeys(id);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setError(null);
    const payload = {
      name: form.name.trim(),
      protocol: form.protocol,
      baseUrl: form.baseUrl.trim(),
      enabledModels: form.enabledModels
        .split(",")
        .map((m) => m.trim())
        .filter(Boolean),
      priority: Number(form.priority) || 0,
    };
    const newKeys = formKeys.map((k) => k.trim()).filter(Boolean);
    try {
      const res = editingId
        ? await apiFetch(`/api/admin/upstreams/${editingId}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          })
        : await apiFetch("/api/admin/upstreams", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(payload),
          });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to save upstream");
        return;
      }
      const upstreamId = editingId ?? (json.data as { id: number }).id;
      for (const apiKey of newKeys) {
        const keyRes = await apiFetch(`/api/admin/upstreams/${upstreamId}/keys`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ apiKey }),
        });
        const keyJson = await keyRes.json();
        if (!keyJson.success) {
          setError(keyJson.error || "Failed to add an API key");
          break;
        }
      }
      setForm(EMPTY_FORM);
      setFormKeys([""]);
      setFormKeyTests({});
      setEditingId(null);
      loadUpstreams();
    } catch {
      setError("Network error");
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (u: UpstreamItem) => {
    setEditingId(u.id);
    setForm({
      name: u.name,
      protocol: u.protocol,
      baseUrl: u.baseUrl,
      enabledModels: u.enabledModels.join(", "),
      priority: String(u.priority),
    });
    setFormKeys([""]);
    setFormKeyTests({});
    setModelPicker(null);
    loadKeys(u.id);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const handleDelete = async (id: number) => {
    if (!confirm("Delete this upstream?")) return;
    await apiFetch(`/api/admin/upstreams/${id}`, { method: "DELETE" });
    loadUpstreams();
  };

  const handleToggleEnabled = async (u: UpstreamItem) => {
    await apiFetch(`/api/admin/upstreams/${u.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !u.enabled }),
    });
    loadUpstreams();
  };

  const handleAddKey = async (upstreamId: number) => {
    const apiKey = (newKeyInput[upstreamId] || "").trim();
    if (!apiKey) return;
    const res = await apiFetch(`/api/admin/upstreams/${upstreamId}/keys`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ apiKey }),
    });
    const json = await res.json();
    if (!json.success) {
      setTestResults((prev) => ({ ...prev, [upstreamId]: { ok: false, error: json.error } }));
      return;
    }
    setNewKeyInput((prev) => ({ ...prev, [upstreamId]: "" }));
    loadKeys(upstreamId);
  };

  const handleToggleKey = async (key: UpstreamKeyItem) => {
    await apiFetch(`/api/admin/upstreams/${key.upstreamId}/keys/${key.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: !key.enabled }),
    });
    loadKeys(key.upstreamId);
  };

  const handleDeleteKey = async (key: UpstreamKeyItem) => {
    if (!confirm("Delete this key?")) return;
    await apiFetch(`/api/admin/upstreams/${key.upstreamId}/keys/${key.id}`, {
      method: "DELETE",
    });
    loadKeys(key.upstreamId);
  };

  const handleTest = async (u: UpstreamItem) => {
    setTestResults((prev) => ({ ...prev, [u.id]: null }));
    const res = await apiFetch(`/api/admin/upstreams/${u.id}/test`, { method: "POST" });
    const json = await res.json();
    setTestResults((prev) => ({ ...prev, [u.id]: json.data ?? { ok: false, error: json.error } }));
  };

  const toggleExpand = (id: number) => {
    const next = { ...expanded, [id]: !expanded[id] };
    setExpanded(next);
    if (next[id]) {
      setBalanceInput((prev) => {
        if (prev[id] !== undefined) return prev;
        const u = upstreams.find((x) => x.id === id);
        return { ...prev, [id]: u?.balance ?? "" };
      });
      if (!keysByUpstream[id]) {
        loadKeys(id);
      }
    }
  };

  const handleSaveBalance = async (u: UpstreamItem) => {
    const value = (balanceInput[u.id] ?? "").trim();
    const res = await apiFetch(`/api/admin/upstreams/${u.id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ balance: value === "" ? null : value }),
    });
    const json = await res.json();
    if (!json.success) {
      setError(json.error || "Failed to save balance");
      return;
    }
    loadUpstreams();
  };

  const handleRefreshBalance = async (u: UpstreamItem) => {
    setRefreshingBalance((prev) => ({ ...prev, [u.id]: true }));
    setError(null);
    try {
      const res = await apiFetch(`/api/admin/upstreams/${u.id}/balance/refresh`, { method: "POST" });
      const json = await res.json();
      if (!json.success) {
        setError(json.error || "Failed to refresh balance");
      } else {
        // 同步展开区输入框与标题显示（refresh 接口返回新余额）
        setBalanceInput((prev) => ({
          ...prev,
          [u.id]: json.data?.balance !== undefined ? String(json.data.balance) : (prev[u.id] ?? ""),
        }));
      }
      loadUpstreams();
    } catch {
      setError("Network error");
    } finally {
      setRefreshingBalance((prev) => ({ ...prev, [u.id]: false }));
    }
  };

  const addFormKeyRow = () => {
    setFormKeys((prev) => [...prev, ""]);
  };

  const removeFormKeyRow = (index: number) => {
    setFormKeys((prev) => prev.filter((_, i) => i !== index));
    setFormKeyTests((prev) => {
      const next = { ...prev };
      delete next[index];
      return next;
    });
  };

  const updateFormKey = (index: number, value: string) => {
    setFormKeys((prev) => prev.map((k, i) => (i === index ? value : k)));
    setFormKeyTests((prev) => ({ ...prev, [index]: null }));
  };

  const testFormKey = async (index: number) => {
    const apiKey = formKeys[index]?.trim();
    if (!apiKey) return;
    setFormKeyTests((prev) => ({ ...prev, [index]: null }));
    try {
      const res = await apiFetch("/api/admin/upstreams/test-connection", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: form.protocol,
          baseUrl: form.baseUrl.trim(),
          apiKey,
        }),
      });
      const json = await res.json();
      if (json.success && json.data) {
        setFormKeyTests((prev) => ({ ...prev, [index]: json.data }));
      } else {
        setFormKeyTests((prev) => ({
          ...prev,
          [index]: { ok: false, status: 0, error: json.error || "Test failed" },
        }));
      }
    } catch {
      setFormKeyTests((prev) => ({ ...prev, [index]: { ok: false, status: 0, error: "Network error" } }));
    }
  };

  const firstFormKey = () => formKeys.map((k) => k.trim()).find(Boolean) || "";

  const handleFetchModels = async () => {
    const apiKey = firstFormKey();
    if (!apiKey) return;
    setFetchingModels(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/upstreams/fetch-models", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          protocol: form.protocol,
          baseUrl: form.baseUrl.trim(),
          apiKey,
        }),
      });
      const json = await res.json();
      if (json.success && json.data) {
        setModelPicker({
          models: json.data.models as string[],
          selected: new Set<string>(),
          error: json.data.error || undefined,
        });
      } else {
        setModelPicker({
          models: [],
          selected: new Set<string>(),
          error: json.error || "Failed to fetch models",
        });
      }
    } catch {
      setModelPicker({ models: [], selected: new Set<string>(), error: "Network error" });
    } finally {
      setFetchingModels(false);
    }
  };

  const togglePickerModel = (model: string) => {
    setModelPicker((prev) => {
      if (!prev) return prev;
      const next = new Set(prev.selected);
      if (next.has(model)) {
        next.delete(model);
      } else {
        next.add(model);
      }
      return { ...prev, selected: next };
    });
  };

  const confirmModelPicker = () => {
    if (!modelPicker) return;
    const current = form.enabledModels
      .split(",")
      .map((m) => m.trim())
      .filter(Boolean);
    const merged = Array.from(new Set([...current, ...Array.from(modelPicker.selected)]));
    setForm({ ...form, enabledModels: merged.join(", ") });
    setModelPicker(null);
  };

  if (loading) {
    return <div className="h-40 flex items-center justify-center text-gray-400">Loading...</div>;
  }

  return (
    <div className="space-y-6">
      {error && (
        <div className="rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">{error}</div>
      )}

      {/* 新建/编辑表单 */}
      <div className="rounded-lg bg-white p-6 shadow">
        <h2 className="mb-4 text-lg font-semibold">
          {editingId ? `Edit Upstream #${editingId}` : "New Upstream"}
        </h2>
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-[1fr_200px_200px] gap-4">
          <div className="relative">
            <label className="mb-1 block text-sm text-gray-600">Name</label>
            <input
              value={form.name}
              onChange={(e) => {
                setForm({ ...form, name: e.target.value });
                setShowPresets(true);
              }}
              onFocus={() => setShowPresets(true)}
              onBlur={() => setTimeout(() => setShowPresets(false), 150)}
              placeholder="e.g. deepseek"
              required
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
            {showPresets && filteredPresets.length > 0 && (
              <div className="absolute z-10 mt-1 max-h-48 w-full overflow-y-auto rounded border border-gray-200 bg-white shadow-lg">
                {filteredPresets.map((p) => (
                  <button
                    key={p.name}
                    type="button"
                    onMouseDown={(e) => {
                      e.preventDefault();
                      setForm({
                        ...form,
                        name: p.name,
                        protocol: p.protocol,
                        baseUrl: p.baseUrl,
                      });
                      setShowPresets(false);
                    }}
                    className="flex w-full items-center justify-between px-3 py-1.5 text-left text-sm hover:bg-gray-50"
                  >
                    <span>{p.name}</span>
                    <span className="text-xs text-gray-400">{p.baseUrl}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">Protocol</label>
            <select
              value={form.protocol}
              onChange={(e) => setForm({ ...form, protocol: e.target.value })}
              className="w-full rounded border border-gray-300 bg-white px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            >
              {PROTOCOLS.map((p) => (
                <option key={p} value={p}>{p}</option>
              ))}
            </select>
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">Priority (model routing)</label>
            <input
              type="number"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="md:col-span-3">
            <label className="mb-1 block text-sm text-gray-600">Base URL</label>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="e.g. https://api.deepseek.com"
              required
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="md:col-span-3">
            <label className="mb-1 block text-sm text-gray-600">
              API Keys{" "}
              <span className="text-gray-400">
                ({editingId ? "existing keys are kept, new keys below are appended" : "optional at creation, add more later"})
              </span>
            </label>
            {editingId && (keysByUpstream[editingId] ?? []).length > 0 && (
              <div className="mb-2 flex flex-wrap gap-1.5">
                {(keysByUpstream[editingId] ?? []).map((k) => (
                  <span
                    key={k.id}
                    title={`${k.enabled ? "Enabled" : "Disabled"}${k.lastStatus ? ` · last: ${k.lastStatus}` : ""}`}
                    className="flex items-center gap-1.5 rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600"
                  >
                    <span className={`h-1.5 w-1.5 rounded-full ${k.enabled ? "bg-green-500" : "bg-gray-300"}`} />
                    <code>{k.maskedKey}</code>
                  </span>
                ))}
              </div>
            )}
            <div className="space-y-2">
              {formKeys.map((keyValue, index) => (
                <div key={index}>
                  <div className="flex items-center gap-2">
                    <input
                      type="password"
                      autoComplete="new-password"
                      value={keyValue}
                      onChange={(e) => updateFormKey(index, e.target.value)}
                      placeholder={`API key ${index + 1}`}
                      className="flex-1 rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                    />
                    <button
                      type="button"
                      onClick={() => testFormKey(index)}
                      disabled={!keyValue.trim() || !form.baseUrl.trim()}
                      className="rounded border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                    >
                      Test
                    </button>
                    <button
                      type="button"
                      onClick={() => removeFormKeyRow(index)}
                      className="rounded border border-gray-300 px-3 py-2 text-xs text-gray-600 hover:bg-gray-50"
                      title="Remove key"
                    >
                      −
                    </button>
                  </div>
                  {formKeyTests[index] && (
                    <p
                      className={`mt-1 text-xs ${
                        formKeyTests[index]?.ok ? "text-green-600" : "text-red-600"
                      }`}
                    >
                      {formKeyTests[index]?.ok
                        ? "Connection OK"
                        : `Test failed: ${formKeyTests[index]?.error || "unknown error"}`}
                    </p>
                  )}
                </div>
              ))}
            </div>
            <button
              type="button"
              onClick={addFormKeyRow}
              className="mt-2 rounded border border-dashed border-gray-300 px-3 py-1.5 text-xs text-gray-500 hover:bg-gray-50"
            >
              + Add key
            </button>
          </div>
          <div className="md:col-span-3">
            <div className="mb-1 flex items-center justify-between">
              <label className="block text-sm text-gray-600">
                Enabled Models <span className="text-gray-400">(comma separated, supports gpt-* wildcard)</span>
              </label>
              <button
                type="button"
                onClick={handleFetchModels}
                disabled={fetchingModels || !form.baseUrl.trim() || !firstFormKey()}
                className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
              >
                {fetchingModels ? "Fetching..." : "Fetch Models"}
              </button>
            </div>
            <input
              value={form.enabledModels}
              onChange={(e) => setForm({ ...form, enabledModels: e.target.value })}
              placeholder="deepseek-chat, deepseek-*"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="md:col-span-3 flex items-center gap-2">
            <button
              type="submit"
              disabled={saving}
              className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : editingId ? "Save" : "Create"}
            </button>
            {editingId && (
              <button
                type="button"
                onClick={() => {
                  setEditingId(null);
                  setForm(EMPTY_FORM);
                  setFormKeys([""]);
                  setFormKeyTests({});
                }}
                className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
            )}
          </div>
        </form>
      </div>

      {modelPicker && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl">
            <div className="flex items-center justify-between border-b px-5 py-3">
              <h3 className="font-semibold">
                Select models for {form.name.trim() || "new upstream"}
                <span className="ml-2 text-xs font-normal text-gray-400">
                  {modelPicker.models.length} available · {modelPicker.selected.size} selected
                </span>
              </h3>
              <button
                type="button"
                onClick={() => setModelPicker(null)}
                className="text-2xl leading-none text-gray-400 hover:text-gray-600"
              >
                ×
              </button>
            </div>

            {modelPicker.error && (
              <div className="mx-5 mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
                Fetch failed: {modelPicker.error}
              </div>
            )}

            <div className="flex-1 overflow-y-auto p-5">
              {modelPicker.models.length === 0 && !modelPicker.error ? (
                <div className="py-10 text-center text-gray-400">
                  No models found. Close this dialog and add models manually.
                </div>
              ) : (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                  {modelPicker.models.map((model) => (
                    <label
                      key={model}
                      className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-gray-50"
                    >
                      <input
                        type="checkbox"
                        checked={modelPicker.selected.has(model)}
                        onChange={() => togglePickerModel(model)}
                        className="rounded border-gray-300"
                      />
                      <code className="truncate" title={model}>{model}</code>
                    </label>
                  ))}
                </div>
              )}
            </div>

            <div className="flex items-center justify-end border-t px-5 py-3 gap-2">
              <button
                type="button"
                onClick={() => setModelPicker(null)}
                className="rounded border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmModelPicker}
                disabled={modelPicker.models.length === 0}
                className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
              >
                Apply ({modelPicker.selected.size})
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 上游列表 */}
      <div className="space-y-4">
        {upstreams.length === 0 && (
          <div className="rounded-lg border border-dashed border-gray-300 p-8 text-center text-gray-400">
            No upstreams configured yet. Create one above.
          </div>
        )}
        {upstreams.map((u) => (
          <div key={u.id} className="rounded-lg bg-white p-5 shadow">
            <div className="flex flex-wrap items-center gap-3">
              <span className={`h-2 w-2 rounded-full ${u.enabled ? "bg-green-500" : "bg-gray-300"}`} />
              <button
                type="button"
                onClick={() => toggleExpand(u.id)}
                className="text-gray-400 hover:text-gray-600"
                title={expanded[u.id] ? "Collapse" : "Expand"}
              >
                {expanded[u.id] ? "▾" : "▸"}
              </button>
              <span className="font-semibold">{u.name}</span>
              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{u.protocol}</span>
              <span className="text-xs text-gray-400 truncate max-w-md">{u.baseUrl}</span>
              <span className="text-xs text-gray-400">
                {u.enabledModels.length} models · {u.keyCount} keys · priority {u.priority}
              </span>
              {u.balance !== null && (
                <span className="text-xs font-medium text-gray-500">balance: {u.balance}</span>
              )}
              <div className="ml-auto flex items-center gap-2">
                <button
                  type="button"
                  onClick={() => handleTest(u)}
                  className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  Test
                </button>
                <button
                  type="button"
                  onClick={() => handleToggleEnabled(u)}
                  className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  {u.enabled ? "Disable" : "Enable"}
                </button>
                <button
                  type="button"
                  onClick={() => handleEdit(u)}
                  className="rounded border border-gray-300 px-2.5 py-1 text-xs text-gray-600 hover:bg-gray-50"
                >
                  Edit
                </button>
                <button
                  type="button"
                  onClick={() => handleDelete(u.id)}
                  className="rounded border border-red-200 px-2.5 py-1 text-xs text-red-600 hover:bg-red-50"
                >
                  Delete
                </button>
              </div>
            </div>

            {testResults[u.id] && (
              <div
                className={`mt-3 rounded p-3 text-sm ${
                  testResults[u.id]?.ok
                    ? "bg-green-50 text-green-700"
                    : "bg-red-50 text-red-600"
                }`}
              >
                {testResults[u.id]?.ok
                  ? `Connection OK · ${testResults[u.id]?.modelCount} models available`
                  : `Test failed: ${testResults[u.id]?.error || "unknown error"}`}
              </div>
            )}

            {expanded[u.id] && (
              <div className="mt-4 space-y-4 border-l-2 border-gray-100 pl-4">
                <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm">
                  <div>
                    <div className="text-xs text-gray-400">Base URL</div>
                    <code className="break-all text-xs">{u.baseUrl}</code>
                  </div>
                  <div className="flex gap-6">
                    <div>
                      <div className="text-xs text-gray-400">Priority</div>
                      <div>{u.priority}</div>
                    </div>
                    <div>
                      <div className="text-xs text-gray-400">Created</div>
                      <div className="text-xs">{new Date(u.createdAt).toLocaleString()}</div>
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <div className="text-xs text-gray-400">Enabled Models</div>
                    <div className="mt-1 flex flex-wrap gap-1">
                      {u.enabledModels.length === 0 && (
                        <span className="text-xs text-gray-300">(none)</span>
                      )}
                      {u.enabledModels.map((m) => (
                        <code key={m} className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                          {m}
                        </code>
                      ))}
                    </div>
                  </div>
                  <div className="md:col-span-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-gray-400">Balance</span>
                      <input
                        value={balanceInput[u.id] ?? u.balance ?? ""}
                        onChange={(e) =>
                          setBalanceInput((prev) => ({ ...prev, [u.id]: e.target.value }))
                        }
                        placeholder="0"
                        className="w-28 rounded border border-gray-300 px-2 py-1 text-xs focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      />
                      <button
                        type="button"
                        onClick={() => handleSaveBalance(u)}
                        className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50"
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        onClick={() => handleRefreshBalance(u)}
                        disabled={refreshingBalance[u.id]}
                        className="rounded border border-gray-300 px-2 py-1 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-40"
                      >
                        {refreshingBalance[u.id] ? "Refreshing..." : "↻ Refresh"}
                      </button>
                      {u.balanceUpdatedAt && (
                        <span className="text-xs text-gray-300">
                          updated {new Date(u.balanceUpdatedAt).toLocaleString()}
                        </span>
                      )}
                    </div>
                  </div>
                </div>

                <div className="space-y-2">
                  <div className="flex items-center gap-4">
                    <button
                      type="button"
                      onClick={() => toggleKeys(u.id)}
                      className="text-xs text-gray-500 hover:text-blue-600"
                    >
                      {expandedKeys[u.id] ? "▾" : "▸"} API Keys
                    </button>
                    <UpstreamModelsManager upstream={u} onUpdated={loadUpstreams} />
                  </div>

                  {expandedKeys[u.id] && (
                    <div className="space-y-2">
                      {(keysByUpstream[u.id] || []).map((key) => (
                        <div key={key.id} className="flex items-center gap-3 text-sm">
                          <span className={`h-1.5 w-1.5 rounded-full ${key.enabled ? "bg-green-500" : "bg-gray-300"}`} />
                          <code className="rounded bg-gray-100 px-2 py-0.5 text-xs">{key.maskedKey}</code>
                          {key.lastStatus && (
                            <span className="text-xs text-gray-400">last: {key.lastStatus}</span>
                          )}
                          <div className="ml-auto flex gap-2">
                            <button
                              type="button"
                              onClick={() => handleToggleKey(key)}
                              className="text-xs text-gray-500 hover:text-blue-600"
                            >
                              {key.enabled ? "Disable" : "Enable"}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleDeleteKey(key)}
                              className="text-xs text-red-500 hover:text-red-700"
                            >
                              Delete
                            </button>
                          </div>
                        </div>
                      ))}
                      {keysByUpstream[u.id]?.length === 0 && (
                        <p className="text-xs text-gray-400">No keys yet.</p>
                      )}
                      <div className="flex gap-2">
                        <input
                          type="password"
                          autoComplete="new-password"
                          value={newKeyInput[u.id] || ""}
                          onChange={(e) =>
                            setNewKeyInput((prev) => ({ ...prev, [u.id]: e.target.value }))
                          }
                          onKeyDown={(e) => e.key === "Enter" && handleAddKey(u.id)}
                          placeholder="New upstream API key..."
                          className="flex-1 rounded border border-gray-300 px-3 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                        />
                        <button
                          type="button"
                          onClick={() => handleAddKey(u.id)}
                          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700"
                        >
                          Add
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
