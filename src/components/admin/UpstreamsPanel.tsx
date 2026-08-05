"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
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

export default function UpstreamsPanel() {
  const [upstreams, setUpstreams] = useState<UpstreamItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const [keysByUpstream, setKeysByUpstream] = useState<Record<number, UpstreamKeyItem[]>>({});
  const [expandedKeys, setExpandedKeys] = useState<Record<number, boolean>>({});
  const [newKeyInput, setNewKeyInput] = useState<Record<number, string>>({});
  const [testResults, setTestResults] = useState<Record<number, { ok: boolean; modelCount?: number; error?: string } | null>>({});

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
      setForm(EMPTY_FORM);
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
        <form onSubmit={handleSubmit} className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div>
            <label className="mb-1 block text-sm text-gray-600">Name</label>
            <input
              value={form.name}
              onChange={(e) => setForm({ ...form, name: e.target.value })}
              placeholder="e.g. deepseek"
              required
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
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
          <div className="md:col-span-2">
            <label className="mb-1 block text-sm text-gray-600">Base URL</label>
            <input
              value={form.baseUrl}
              onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
              placeholder="e.g. https://api.deepseek.com"
              required
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="md:col-span-2">
            <label className="mb-1 block text-sm text-gray-600">
              Enabled Models <span className="text-gray-400">(comma separated, supports gpt-* wildcard)</span>
            </label>
            <input
              value={form.enabledModels}
              onChange={(e) => setForm({ ...form, enabledModels: e.target.value })}
              placeholder="deepseek-chat, deepseek-*"
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="mb-1 block text-sm text-gray-600">Priority <span className="text-gray-400">(lower = preferred)</span></label>
            <input
              type="number"
              value={form.priority}
              onChange={(e) => setForm({ ...form, priority: e.target.value })}
              className="w-full rounded border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
            />
          </div>
          <div className="flex items-end">
            <div className="flex gap-2">
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
                  }}
                  className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50"
                >
                  Cancel
                </button>
              )}
            </div>
          </div>
        </form>
      </div>

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
              <span className="font-semibold">{u.name}</span>
              <span className="rounded bg-gray-100 px-2 py-0.5 text-xs text-gray-600">{u.protocol}</span>
              <span className="text-xs text-gray-400 truncate max-w-md">{u.baseUrl}</span>
              <span className="text-xs text-gray-400">
                {u.enabledModels.length} models · {u.keyCount} keys · priority {u.priority}
              </span>
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

            <div className="mt-3">
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
                <div className="mt-3 space-y-2 border-l-2 border-gray-100 pl-4">
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
        ))}
      </div>
    </div>
  );
}
