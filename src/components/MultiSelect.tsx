"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { MAX_FILTER_VALUES } from "@/lib/filter-params";

export interface MultiSelectOption {
  id: string;
  name: string;
}

// 多维筛选下拉（Dashboard / Records 共用）：搜索 + 复选 + 全选/取消。
// value 为空数组 = 不筛选（等价于 All）；提交顺序恒为 options 顺序，与点击顺序无关。
interface MultiSelectProps {
  label: string;
  allLabel: string;
  options: MultiSelectOption[];
  value: string[];
  onChange: (next: string[]) => void;
}

export default function MultiSelect({
  label,
  allLabel,
  options,
  value,
  onChange,
}: MultiSelectProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 乐观选择：父级的 value 要等 URL / state 回流才变，快速连点会基于旧值覆盖先前选择
  const [draft, setDraft] = useState<string[] | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const current = draft ?? value;
  const valueKey = value.join("\u0000");
  const prevValueKeyRef = useRef(valueKey);
  useEffect(() => {
    // 外部值一旦变化（URL 提交完成 / Reset / 前进后退），放弃乐观值以外部为准
    if (prevValueKeyRef.current === valueKey) return;
    prevValueKeyRef.current = valueKey;
    setDraft(null);
  }, [valueKey]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    // capture + stopPropagation：面板开在移动端抽屉里时，Esc 只关面板，
    // 不再冒泡到抽屉自己的 document 监听把整个抽屉一起关掉
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.stopPropagation();
      setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, [open]);

  // 关闭时清掉搜索词，下次打开总是完整列表
  useEffect(() => {
    if (!open) setQuery("");
  }, [open]);

  const selected = useMemo(() => new Set(current), [current]);

  const filtered = useMemo(() => {
    const keyword = query.trim().toLowerCase();
    if (!keyword) return options;
    return options.filter((option) =>
      `${option.name} ${option.id}`.toLowerCase().includes(keyword)
    );
  }, [options, query]);

  // 提交时按 options 顺序输出，避免选择顺序影响请求参数
  const commit = (next: Set<string>) => {
    const ids = options
      .filter((option) => next.has(option.id))
      .map((option) => option.id);
    setDraft(ids);
    onChange(ids);
  };

  const toggle = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    commit(next);
  };

  const allFilteredSelected =
    filtered.length > 0 && filtered.every((option) => selected.has(option.id));
  // 服务端每维度只接 MAX_FILTER_VALUES 个值，全选超过上限会稳定 400，先在这里拦住
  const selectAllExceedsLimit = current.length + filtered.length > MAX_FILTER_VALUES;

  const selectAll = () => {
    const next = new Set(selected);
    for (const option of filtered) next.add(option.id);
    commit(next);
  };

  const clearAll = () => {
    setDraft([]);
    onChange([]);
  };

  const summary = (() => {
    if (current.length === 0) return allLabel;
    if (current.length === 1) {
      const only = current[0];
      return options.find((option) => option.id === only)?.name ?? only;
    }
    return `${current.length} selected`;
  })();

  return (
    <div ref={containerRef} className="relative min-w-0">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`${label}: ${summary}`}
        title={`${label}: ${summary}`}
        className={`flex min-h-[40px] w-full min-w-0 items-center gap-2 rounded border bg-white px-3 py-1.5 text-left text-sm shadow-sm transition-colors md:min-h-0 md:w-auto ${
          current.length > 0
            ? "border-blue-400 text-blue-700"
            : "border-gray-300 text-gray-700"
        } ${open ? "border-blue-500 ring-1 ring-blue-500" : "hover:bg-gray-50"}`}
      >
        <span className="shrink-0 text-xs font-medium uppercase text-gray-500">
          {label}
        </span>
        <span className="min-w-0 flex-1 truncate">{summary}</span>
        <span className="shrink-0 text-gray-400">▾</span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label={`${label} filter`}
          className="mt-2 w-full rounded-lg border border-gray-200 bg-white shadow-lg md:absolute md:left-0 md:z-30 md:w-72 md:max-w-[calc(100vw-2rem)]"
        >
          <div className="border-b border-gray-100 p-2">
            <input
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search…"
              aria-label={`Search ${label}`}
              className="min-h-[40px] w-full rounded border border-gray-300 px-2 py-1.5 text-base focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 md:min-h-0 md:text-sm"
            />
          </div>
          <div className="flex items-center justify-between gap-2 border-b border-gray-100 px-2 py-1.5">
            <button
              type="button"
              onClick={selectAll}
              disabled={
                filtered.length === 0 || allFilteredSelected || selectAllExceedsLimit
              }
              title={
                selectAllExceedsLimit
                  ? `At most ${MAX_FILTER_VALUES} values per filter`
                  : query.trim()
                    ? "Select all matching options"
                    : "Select all options"
              }
              className="inline-flex min-h-[40px] items-center justify-center rounded px-2 text-xs font-medium text-blue-700 hover:bg-blue-50 disabled:cursor-not-allowed disabled:text-gray-400 md:min-h-0 md:py-1"
            >
              Select all
            </button>
            <button
              type="button"
              onClick={clearAll}
              disabled={current.length === 0}
              className="inline-flex min-h-[40px] items-center justify-center rounded px-2 text-xs font-medium text-gray-600 hover:bg-gray-100 disabled:cursor-not-allowed disabled:text-gray-400 md:min-h-0 md:py-1"
            >
              Clear
            </button>
            <span className="ml-auto tabular-nums text-xs text-gray-400">
              {current.length}/{options.length}
            </span>
          </div>
          <div className="max-h-64 overflow-y-auto p-1">
            {filtered.length === 0 ? (
              <p className="px-2 py-3 text-sm text-gray-400">No matches</p>
            ) : (
              filtered.map((option) => {
                const checked = selected.has(option.id);
                return (
                  <label
                    key={option.id}
                    className="flex min-h-[40px] cursor-pointer items-center gap-2 rounded px-2 text-sm hover:bg-gray-50 md:min-h-0 md:py-1.5"
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(option.id)}
                      className="h-4 w-4 shrink-0 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                    />
                    <span className="min-w-0 truncate text-gray-700">
                      {option.name}
                    </span>
                  </label>
                );
              })
            )}
          </div>
        </div>
      )}
    </div>
  );
}
