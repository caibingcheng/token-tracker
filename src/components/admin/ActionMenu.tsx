"use client";

import { useEffect, useRef, useState } from "react";

export interface ActionItem {
  label: string;
  onClick: () => void;
  variant?: "default" | "danger";
  disabled?: boolean;
}

interface ActionMenuProps {
  label?: string;
  items: ActionItem[];
}

export default function ActionMenu({ label = "Actions", items }: ActionMenuProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  return (
    <div className="relative md:hidden" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        className="min-h-[40px] rounded border border-gray-300 px-2.5 py-1.5 text-xs font-medium text-gray-600 hover:bg-gray-50"
      >
        {label} ▾
      </button>
      {open && (
        <div className="absolute right-0 z-20 mt-1 w-36 rounded border border-gray-200 bg-white shadow-lg">
          {items.map((item, idx) => (
            <button
              key={idx}
              type="button"
              onClick={() => {
                item.onClick();
                setOpen(false);
              }}
              disabled={item.disabled}
              className={`w-full px-3 py-2 text-left text-xs hover:bg-gray-50 disabled:opacity-40 ${
                item.variant === "danger" ? "text-red-600" : "text-gray-700"
              }`}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
