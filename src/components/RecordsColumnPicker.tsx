"use client";

import { useEffect, useRef, useState } from "react";
import {
  RECORD_COLUMNS,
  RECORD_COLUMN_IDS,
  type RecordColumnId,
} from "@/lib/records-columns";

interface RecordsColumnPickerProps {
  value: RecordColumnId[];
  onChange: (next: RecordColumnId[]) => void;
  error?: string | null;
}

export default function RecordsColumnPicker({
  value,
  onChange,
  error,
}: RecordsColumnPickerProps) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onMouseDown);
    return () => document.removeEventListener("mousedown", onMouseDown);
  }, [open]);

  const visible = new Set(value);

  const toggle = (id: RecordColumnId) => {
    const next = new Set(visible);
    if (next.has(id)) {
      if (next.size === 1) return; // 至少保留一列
      next.delete(id);
    } else {
      next.add(id);
    }
    // 始终按定义顺序提交，展示顺序与点击顺序无关
    onChange(RECORD_COLUMN_IDS.filter((columnId) => next.has(columnId)));
  };

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="true"
        title="Choose visible columns"
        className={`inline-flex h-10 items-center gap-1 rounded px-3 text-sm font-medium transition-colors md:h-8 md:text-xs ${
          open ? "bg-blue-100 text-blue-700" : "bg-gray-100 text-gray-600 hover:bg-gray-200"
        }`}
      >
        Columns
        <span className="tabular-nums text-xs opacity-70">
          {value.length}/{RECORD_COLUMN_IDS.length}
        </span>
      </button>

      {open && (
        <div className="absolute right-0 z-30 mt-2 w-64 max-h-[70vh] overflow-y-auto rounded-lg border border-gray-200 bg-white p-2 shadow-lg">
          <p className="px-2 py-1 text-xs font-medium uppercase text-gray-500">Visible columns</p>
          {RECORD_COLUMNS.map((column) => {
            const checked = visible.has(column.id);
            const isLastVisible = checked && value.length === 1;
            return (
              <label
                key={column.id}
                title={isLastVisible ? "At least one column must stay visible" : undefined}
                className={`flex min-h-[40px] items-center gap-2 rounded px-2 text-sm md:min-h-0 md:py-1.5 ${
                  isLastVisible ? "cursor-not-allowed opacity-50" : "cursor-pointer hover:bg-gray-50"
                }`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={isLastVisible}
                  onChange={() => toggle(column.id)}
                  className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                />
                <span className="text-gray-700">{column.label}</span>
              </label>
            );
          })}
          {error && <p className="px-2 pt-2 text-xs text-red-600">{error}</p>}
        </div>
      )}
    </div>
  );
}
