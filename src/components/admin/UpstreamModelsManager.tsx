"use client";

import { useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import { filterModelsByQuery } from "@/lib/model-search";
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
  // 模型列表搜索词（视图过滤，不改写选择集）
  const [query, setQuery] = useState("");
  // 本次会话是否已成功拉取上游列表（拉取成功后才具备「已下架」判断基准）
  const [fetchedOk, setFetchedOk] = useState(false);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const missingAllRef = useRef<HTMLInputElement>(null);

  const manual = data?.manual ?? [];
  const available = data?.available ?? [];

  // 通配规则（gpt-*）：上游列表只返回具体模型名，无条目可对比 → 不进入可勾选列表、不落入「已下架」区段，
  // 由 save() 无条件保留（对齐表单 Fetch Models 弹窗的 patterns 逻辑），此处仅作说明展示
  const wildcardRules = manual.filter((m) => m.endsWith("*"));
  const concreteManual = manual.filter((m) => !m.endsWith("*"));

  // 成功拉取后：主列表 = 上游现有模型；否则（未拉取/拉取失败）= 手动配置 ∪ 已拉到的并集
  // 拷贝后再排序，避免原地 .sort() 突变 React state
  const mainModels = (fetchedOk
    ? [...available]
    : Array.from(new Set([...concreteManual, ...available]))
  ).sort();
  // 「原本勾选但上游已不存在」的具体模型：仅拉取成功后才有意义，去重后保持手动配置原顺序置底
  const missingModels = fetchedOk
    ? Array.from(new Set(concreteManual.filter((m) => !available.includes(m))))
    : [];
  // 搜索过滤后的可见子集（空白查询 = 全量）
  const visibleMain = filterModelsByQuery(mainModels, query);
  const visibleMissing = filterModelsByQuery(missingModels, query);
  const hasModels =
    mainModels.length > 0 || missingModels.length > 0 || wildcardRules.length > 0;

  // Select-all 的作用域：有搜索词时为当前可见（过滤后）子集，否则为全量。
  // 勾选状态与动作必须基于同一 scope，否则三态 checkbox 会出现「点了没反应」的断裂。
  const scopeMain = query.trim() ? visibleMain : mainModels;
  const scopeMissing = query.trim() ? visibleMissing : missingModels;
  const allMainSelected = scopeMain.length > 0 && scopeMain.every((m) => selected.has(m));
  const someMainSelected =
    scopeMain.some((m) => selected.has(m)) && !allMainSelected;
  const allMissingSelected =
    scopeMissing.length > 0 && scopeMissing.every((m) => selected.has(m));
  const someMissingSelected =
    scopeMissing.some((m) => selected.has(m)) && !allMissingSelected;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someMainSelected;
    }
  }, [someMainSelected]);

  useEffect(() => {
    if (missingAllRef.current) {
      missingAllRef.current.indeterminate = someMissingSelected;
    }
  }, [someMissingSelected]);

  // 打开 modal 直接用 upstream.enabledModels 渲染；仅点 "↻ Pull from upstream" 才调用上游接口
  const openModal = () => {
    setData({ manual: upstream.enabledModels, available: [], merged: upstream.enabledModels });
    setFetchedOk(false);
    setSelected(new Set(upstream.enabledModels));
    setQuery("");
    setOpen(true);
  };

  const pull = async () => {
    setLoading(true);
    try {
      const res = await apiFetch(`/api/admin/upstreams/${upstream.id}/models`);
      const json = await res.json();
      if (json.success) {
        const d = json.data as ModelsData;
        setData(d);
        const ok = !d.error && Array.isArray(d.available);
        // 只有拿到真实上游列表（无错误）才算成功拉取
        setFetchedOk(ok);
        // 新拉取的模型不默认选中，只保留原有手动配置的；拉取失败时保留用户当前勾选
        if (ok) setSelected(new Set(d.manual ?? []));
      } else {
        // 请求层失败（HTTP/网络/无 key）：给出可见错误，且不动当前勾选
        setData((prev) => ({
          manual: prev?.manual ?? [],
          available: prev?.available ?? [],
          merged: prev?.merged ?? [],
          error: json.error || "Failed to fetch models",
        }));
      }
    } finally {
      setLoading(false);
    }
  };

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
      // 通配模式（如 gpt-*）不参与「已下架」判定也无具体可勾选项，无条件原样保留
      // （对齐表单 Fetch Models 弹窗的 patterns 保留逻辑，防误删配置）
      const patterns = manual.filter((m) => m.endsWith("*"));
      const enabled = Array.from(new Set([...patterns, ...Array.from(selected)]));
      const res = await apiFetch(`/api/admin/upstreams/${upstream.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabledModels: enabled }),
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
        onClick={openModal}
        className="text-xs text-gray-500 hover:text-blue-600"
      >
        Models
      </button>
    );
  }

  // 主列表「全部勾选/取消」：作用于当前 scope（有搜索词 = 可见子集），不动下方已下架区段
  const toggleSelectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of scopeMain) {
        if (allMainSelected) {
          next.delete(m);
        } else {
          next.add(m);
        }
      }
      return next;
    });
  };

  // 已下架区段「全部勾选/取消」：作用于当前 scope
  const toggleMissingAll = () => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const m of scopeMissing) {
        if (allMissingSelected) {
          next.delete(m);
        } else {
          next.add(m);
        }
      }
      return next;
    });
  };

  const mainSelectLabel = missingModels.length > 0
    ? allMainSelected ? "Unselect all available" : "Select all available"
    : allMainSelected ? "Unselect all" : "Select all";

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="flex h-full w-full flex-col rounded-none bg-white shadow-xl md:h-auto md:max-h-[80vh] md:w-full md:max-w-2xl md:rounded-lg">
        <div className="flex items-center justify-between border-b px-5 py-3">
          <h3 className="font-semibold">
            Models for {upstream.name}
            <span className="ml-2 text-xs font-normal text-gray-400">
              {data?.available.length ?? 0} available upstream · {selected.size} selected
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
          ) : !hasModels ? (
            <div className="py-10 text-center text-gray-400">
              No models found. Pull models from upstream or add them manually in the upstream form.
            </div>
          ) : (
            <div>
              <div className="relative mb-3">
                <input
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search models..."
                  className="w-full rounded border border-gray-300 bg-white py-2 pl-9 pr-8 text-base shadow-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:text-sm"
                />
                <svg
                  className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400"
                  fill="none"
                  viewBox="0 0 24 24"
                  stroke="currentColor"
                  strokeWidth={2}
                >
                  <path
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M21 21l-4.35-4.35M17 10.5a6.5 6.5 0 11-13 0 6.5 6.5 0 0113 0z"
                  />
                </svg>
                {query && (
                  <button
                    type="button"
                    onClick={() => setQuery("")}
                    className="absolute right-2 top-1/2 flex h-6 w-6 -translate-y-1/2 items-center justify-center text-gray-400 hover:text-gray-600"
                    aria-label="Clear search"
                  >
                    ✕
                  </button>
                )}
              </div>
              {mainModels.length > 0 && (
                <div>
                  <label className="mb-2 flex items-center gap-2 rounded border border-gray-200 bg-gray-50 px-3 py-2 text-sm text-gray-600">
                    <input
                      ref={selectAllRef}
                      type="checkbox"
                      checked={allMainSelected}
                      onChange={toggleSelectAll}
                      disabled={scopeMain.length === 0}
                      className="rounded border-gray-300"
                    />
                    {mainSelectLabel}
                  </label>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                    {visibleMain.map((model) => (
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
                        {available.includes(model) && !manual.includes(model) && (
                          <span className="ml-auto shrink-0 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] text-blue-600">
                            pulled
                          </span>
                        )}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {missingModels.length > 0 && (
                <div className="mt-5 border-t border-gray-200 pt-3">
                  <div className="flex items-center justify-between gap-2">
                    <h4 className="text-xs font-medium text-gray-500">
                      Removed from upstream ({missingModels.length})
                    </h4>
                    <label className="flex cursor-pointer items-center gap-1.5 text-xs text-gray-500 hover:text-gray-700">
                      <input
                        ref={missingAllRef}
                        type="checkbox"
                        checked={allMissingSelected}
                        onChange={toggleMissingAll}
                        disabled={scopeMissing.length === 0}
                        className="rounded border-gray-300"
                      />
                      {allMissingSelected ? "Unselect all" : "Select all"}
                    </label>
                  </div>
                  <p className="mb-2 mt-1 text-xs text-gray-400">
                    These previously enabled models were not returned by the upstream list. Keep
                    them selected to retain, or clear the section to drop them.
                  </p>
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-1">
                    {visibleMissing.map((model) => (
                      <label
                        key={model}
                        title="No longer available on this upstream"
                        className="flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-gray-50"
                      >
                        <input
                          type="checkbox"
                          checked={selected.has(model)}
                          onChange={() => toggleModel(model)}
                          className="rounded border-gray-300"
                        />
                        <code className="truncate text-gray-400">{model}</code>
                        <span className="ml-auto shrink-0 rounded bg-gray-100 px-1.5 py-0.5 text-[10px] text-gray-400">
                          removed
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              {query.trim() && visibleMain.length === 0 && visibleMissing.length === 0 && (
                <p className="py-2 text-center text-xs text-gray-400">
                  No matches in {mainModels.length + missingModels.length} models
                </p>
              )}

              {wildcardRules.length > 0 && (
                <p className="mt-4 border-t border-gray-200 pt-3 text-xs text-gray-400">
                  Kept wildcard rules: <code className="text-gray-500">{wildcardRules.join(", ")}</code>{" "}
                  — the upstream list only returns concrete model names; wildcard patterns are always
                  preserved when saving.
                </p>
              )}
            </div>
          )}
        </div>

        <div className="flex items-center justify-between border-t px-5 py-3">
          <button
            type="button"
            onClick={pull}
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
