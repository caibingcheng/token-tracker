"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";

interface DisplayData {
  value: string;
  envValue: string;
  envOverridden: boolean;
}

interface SessionTtlData {
  value: number | null;
  envValue: string | null;
  envOverridden: boolean;
}

interface StreamTimeoutData {
  value: number | null;
}

export default function DisplaySettings() {
  const [data, setData] = useState<DisplayData | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ttlData, setTtlData] = useState<SessionTtlData | null>(null);
  const [ttlDraft, setTtlDraft] = useState("");
  const [ttlBusy, setTtlBusy] = useState(false);
  const [ttlError, setTtlError] = useState<string | null>(null);
  const [ttlSaved, setTtlSaved] = useState(false);
  const [streamData, setStreamData] = useState<StreamTimeoutData | null>(null);
  const [streamDraft, setStreamDraft] = useState("");
  const [streamBusy, setStreamBusy] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [streamSaved, setStreamSaved] = useState(false);

  const load = useCallback(async () => {
    const [res, ttlRes, streamRes] = await Promise.all([
      apiFetch("/api/admin/settings/display"),
      apiFetch("/api/admin/settings/session"),
      apiFetch("/api/admin/settings/stream"),
    ]);
    const json = await res.json();
    const ttlJson = await ttlRes.json();
    const streamJson = await streamRes.json();
    if (json.success) {
      setData(json.data as DisplayData);
      setDraft((json.data as DisplayData).value);
    }
    if (ttlJson.success) {
      const t = ttlJson.data as SessionTtlData;
      setTtlData(t);
      setTtlDraft(t.value !== null ? String(t.value) : "");
    }
    if (streamJson.success) {
      const s = streamJson.data as StreamTimeoutData;
      setStreamData(s);
      setStreamDraft(s.value !== null ? String(s.value) : "");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const handleSave = async () => {
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      const res = await apiFetch("/api/admin/settings/display", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: draft }),
      });
      const json = await res.json();
      if (json.success) {
        setSaved(true);
        load();
      } else {
        setError(json.error || "Failed to save");
      }
    } catch {
      setError("Network error");
    } finally {
      setBusy(false);
    }
  };

  // 简单语法校验预览：按分号拆组，展示分组数量
  const groups = draft
    .split(";")
    .map((g) => g.trim())
    .filter((g) => g.length > 0);

  const handleSaveTtl = async () => {
    setTtlBusy(true);
    setTtlError(null);
    setTtlSaved(false);
    try {
      const res = await apiFetch("/api/admin/settings/session", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: ttlDraft }),
      });
      const json = await res.json();
      if (json.success) {
        setTtlSaved(true);
        load();
      } else {
        setTtlError(json.error || "Failed to save");
      }
    } catch {
      setTtlError("Network error");
    } finally {
      setTtlBusy(false);
    }
  };

  const handleSaveStream = async () => {
    setStreamBusy(true);
    setStreamError(null);
    setStreamSaved(false);
    try {
      const res = await apiFetch("/api/admin/settings/stream", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: streamDraft }),
      });
      const json = await res.json();
      if (json.success) {
        setStreamSaved(true);
        load();
      } else {
        setStreamError(json.error || "Failed to save");
      }
    } catch {
      setStreamError("Network error");
    } finally {
      setStreamBusy(false);
    }
  };

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
      <textarea
        value={draft}
        onChange={(e) => {
          setDraft(e.target.value);
          setSaved(false);
        }}
        rows={6}
        spellCheck={false}
        placeholder={'ProviderA:prefix1*,prefix2*;ProviderB:exact-name'}
        className="w-full rounded border border-gray-300 bg-white px-3 py-2 font-mono text-xs shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
      />
      <p className="mt-1 text-xs text-gray-400">
        Semicolons separate groups; comma separates patterns within a group;
        <code className="rounded bg-gray-100 px-1">*</code> suffix = prefix match;
        <code className="rounded bg-gray-100 px-1">Name:</code> prefix = custom display name.
        Groups render as Provider A, B, C... by default.
      </p>

      {draft.trim() !== "" && (
        <p className="mt-2 text-xs text-gray-500">
          Parsed: {groups.length} group{groups.length === 1 ? "" : "s"} —{" "}
          {groups.join(" | ")}
        </p>
      )}

      {error && (
        <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
          {error}
        </div>
      )}
      {saved && (
        <div className="mt-3 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
          Saved. Changes take effect immediately.
        </div>
      )}

      <button
        type="button"
        onClick={handleSave}
        disabled={busy}
        className="mt-4 rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-50"
      >
        {busy ? "Saving..." : "Save"}
      </button>

      <div className="mt-8 border-t border-gray-100 pt-6">
        <h3 className="mb-1 text-base font-semibold text-gray-900">
          Session token lifetime
        </h3>
        <p className="mb-4 text-sm text-gray-500">
          Affects only newly issued tokens; already-issued tokens keep their
          original expiry. Overrides{" "}
          <code className="rounded bg-gray-100 px-1 py-0.5 text-xs">SESSION_TOKEN_TTL_HOURS</code>{" "}
          env (default 24h).
        </p>

        {ttlData?.envOverridden && (
          <div className="mb-4 rounded border border-amber-200 bg-amber-50 p-3 text-sm text-amber-700">
            env SESSION_TOKEN_TTL_HOURS has been overridden by the panel.
          </div>
        )}
        {ttlData?.envValue && !ttlData.envOverridden && (
          <div className="mb-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm text-gray-600">
            Currently falling back to env SESSION_TOKEN_TTL_HOURS (
            {ttlData.envValue}h). Save a value here to take over.
          </div>
        )}

        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            max={720}
            value={ttlDraft}
            onChange={(e) => {
              setTtlDraft(e.target.value);
              setTtlSaved(false);
            }}
            placeholder="24"
            className="w-32 rounded border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-500">hours (1–720)</span>
          <button
            type="button"
            onClick={handleSaveTtl}
            disabled={ttlBusy}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-50"
          >
            {ttlBusy ? "Saving..." : "Save"}
          </button>
        </div>
        {ttlDraft.trim() === "" && (
          <p className="mt-2 text-xs text-gray-400">
            Empty = fall back to env / default 24h.
          </p>
        )}
        {ttlError && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {ttlError}
          </div>
        )}
        {ttlSaved && (
          <div className="mt-3 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
            Saved. New logins will use the updated lifetime.
          </div>
        )}
      </div>

      <div className="mt-8 border-t border-gray-100 pt-6">
        <h3 className="mb-1 text-base font-semibold text-gray-900">
          Stream idle timeout
        </h3>
        <p className="mb-4 text-sm text-gray-500">
          Streaming responses are aborted after receiving no data for this
          duration (prevents stuck upstream connections from lingering). Applies
          to new streams; default 30 minutes.
        </p>

        <div className="flex items-center gap-3">
          <input
            type="number"
            min={1}
            max={1440}
            value={streamDraft}
            onChange={(e) => {
              setStreamDraft(e.target.value);
              setStreamSaved(false);
            }}
            placeholder="30"
            className="w-32 rounded border border-gray-300 bg-white px-3 py-2 text-sm shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          />
          <span className="text-sm text-gray-500">minutes (1–1440)</span>
          <button
            type="button"
            onClick={handleSaveStream}
            disabled={streamBusy}
            className="rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 active:scale-[0.98] transition-all disabled:opacity-50"
          >
            {streamBusy ? "Saving..." : "Save"}
          </button>
        </div>
        {streamDraft.trim() === "" && (
          <p className="mt-2 text-xs text-gray-400">
            Empty = fall back to default 30 minutes.
          </p>
        )}
        {streamError && (
          <div className="mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            {streamError}
          </div>
        )}
        {streamSaved && (
          <div className="mt-3 rounded border border-green-200 bg-green-50 p-3 text-sm text-green-700">
            Saved. New streams will use the updated timeout.
          </div>
        )}
      </div>
    </div>
  );
}
