"use client";

import { useCallback, useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import type { UpstreamItem } from "./UpstreamsPanel";

interface ModelsData {
  manual: string[];
  available: string[];
  merged: string[];
  error?: string | null;
}

export default function UpstreamModelsManager({
  upstream,
  onUpdated,
}: {
  upstream: UpstreamItem;
  onUpdated: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<ModelsData | null>(null);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/admin/upstreams/${upstream.id}/models`);
      const json = await res.json();
      if (json.success) {
        const d = json.data as ModelsData;
        setData(d);
        setSelected(new Set(d.merged ?? d.manual ?? []));
      }
    } finally {
      setLoading(false);
    }
  }, [upstream.id]);

  useEffect(() => {
    if (open) load();
  }, [open, load]);

  const toggleModel = (model: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(model)) {
        next.delete(model);
      } else {
        next.add(model);
      }
      return next;
    });
  };

  const save = async () => {
    setSaving(true);
    try {
      const res = await apiFetch(`/api/admin/upstreams/${upstream.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabledModels: Array.from(selected) }),
      });
      const json = await res.json();
      if (json.success) {
        setOpen(false);
        onUpdated();
      }
    } finally {
      setSaving(false);
    }
  };

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="text-xs text-gray-500 hover:text-blue-600"
      >
        Models
      </button>
    );
  }

  const allModels = Array.from(new Set([...(data?.manual ?? []), ...(data?.available ?? [])])).sort();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg bg-white shadow-xl">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h3 className="font-semibold">
            Models for {upstream.name}
            <span className="ml-2 text-xs font-normal text-gray-400">
              {data?.available.length ?? 0} available upstream · {allModels.length} selected
            </span>
          </h3>
          <button
            type="button"
            onClick={() => setOpen(false)}
            className="text-2xl leading-none text-gray-400 hover:text-gray-600"
          >
            ×
          </button>
        </div>

        {data?.error && (
          <div className="mx-5 mt-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
            Fetch failed: {data.error}
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="py-10 text-center text-gray-400">Fetching models...</div>
          ) : allModels.length === 0 ? (
            <div className="py-10 text-center text-gray-400">
              No models found. Pull models from upstream or add them manually in the upstream form.
            </div>
          ) : (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
              {allModels.map((model) => (
                <label
                  key={model}
                  className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-gray-50"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(model)}
                    onChange={() => toggleModel(model)}
                    className="rounded border-gray-300"
                  />
                  <code className="truncate" title={model}>{model}</code>
                  {data?.available.includes(model) && !data?.manual.includes(model) && (
                    <span className="ml-auto shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600">
                      pulled
                    </span>
                  )}
                </label>
              ))}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t px-5 py-3">
          <button
            type="button"
            onClick={load}
            disabled={loading}
            className="text-sm text-gray-500 hover:text-blue-600 disabled:opacity-50"
          >
            {loading ? "Fetching..." : "↻ Pull from upstream"}
          </button>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => setOpen(false)}
              className="rounded border border-gray-300 px-4 py-1.5 text-sm text-gray-600 hover:bg-gray-50"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={save}
              disabled={saving}
              className="rounded bg-blue-600 px-4 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {saving ? "Saving..." : `Save (${selected.size})`}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
