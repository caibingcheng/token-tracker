"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";

interface MigrationIssue {
  name: string;
  error: string;
}

// 迁移降级启动时的常驻警告：不做静默降级。
// 迁移失败 → 服务仍可用，但相关功能状态可能不对，必须让人看见并给修复指引。
export default function MigrationBanner() {
  const [issues, setIssues] = useState<MigrationIssue[]>([]);
  const [at, setAt] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/admin/migration-status")
      .then((res) => res.json())
      .then((json) => {
        if (cancelled || !json?.success) return;
        setIssues(Array.isArray(json.data?.issues) ? json.data.issues : []);
        setAt(typeof json.data?.at === "string" ? json.data.at : null);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, []);

  if (issues.length === 0 || dismissed) return null;

  return (
    <div className="mb-4 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="font-semibold">Database migration incomplete — service is running degraded</p>
          <p className="mt-1 text-xs text-amber-800">
            The migrations below failed and were skipped; they are retried on every restart. Data is
            untouched, but the affected features may be outdated or read-only.
            {at ? ` (last attempt: ${at})` : ""}
          </p>
          <ul className="mt-2 space-y-1">
            {issues.map((issue) => (
              <li key={issue.name} className="break-words text-xs">
                <code className="rounded bg-amber-100 px-1 py-0.5 font-medium">{issue.name}</code>{" "}
                <span className="text-amber-800">{issue.error}</span>
              </li>
            ))}
          </ul>
          <p className="mt-2 text-xs text-amber-800">
            A pre-migration snapshot was written next to the database file
            (<code className="rounded bg-amber-100 px-1 py-0.5">*.pre-migrate</code>). Fix the cause
            and restart to retry, or stop the service and restore that snapshot to roll back.
          </p>
        </div>
        <button
          type="button"
          onClick={() => setDismissed(true)}
          className="min-h-[40px] shrink-0 rounded border border-amber-300 bg-white px-2 py-1 text-xs font-medium text-amber-900 hover:bg-amber-100 md:min-h-0"
        >
          Hide
        </button>
      </div>
    </div>
  );
}
