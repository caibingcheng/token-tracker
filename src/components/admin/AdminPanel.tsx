"use client";

import { useState } from "react";
import UpstreamsPanel from "./UpstreamsPanel";
import ModelsPanel from "./ModelsPanel";
import VirtualKeysPanel from "./VirtualKeysPanel";
import SecuritySettings from "./SecuritySettings";
import DisplaySettings from "./DisplaySettings";
import AuditLogsPanel from "./AuditLogsPanel";
import SyncPanel from "./SyncPanel";
import Link from "next/link";

type Tab = "upstreams" | "models" | "virtual-keys" | "security" | "display" | "sync" | "audit";

export default function AdminPanel() {
  const [tab, setTab] = useState<Tab>("upstreams");

  return (
    <main className="min-h-screen bg-gray-50 p-4 pb-20 md:p-8 md:pb-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between mb-6 gap-3">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="hidden md:block text-sm text-gray-400 hover:text-blue-600 transition-colors"
            >
              ← Dashboard
            </Link>
            <h1 className="text-xl md:text-3xl font-bold">Gateway Admin</h1>
          </div>
          <div className="flex flex-wrap md:flex-nowrap md:overflow-hidden rounded-md border border-gray-300 bg-white">
            {(
              [
                ["upstreams", "Upstreams"],
                ["models", "Models"],
                ["virtual-keys", "Virtual Keys"],
                ["security", "Security"],
                ["display", "Display"],
                ["sync", "Sync"],
                ["audit", "Audit"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`shrink-0 whitespace-nowrap border-b-2 px-4 py-2 text-sm font-medium transition-colors min-h-[40px] md:min-h-0 w-1/3 md:w-auto ${
                  tab === id
                    ? "border-blue-600 text-blue-700 md:border-transparent md:bg-blue-600 md:text-white"
                    : "border-transparent text-gray-600 hover:bg-gray-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab === "upstreams" ? (
          <UpstreamsPanel />
        ) : tab === "models" ? (
          <ModelsPanel />
        ) : tab === "virtual-keys" ? (
          <VirtualKeysPanel />
        ) : tab === "security" ? (
          <SecuritySettings />
        ) : tab === "display" ? (
          <DisplaySettings />
        ) : tab === "sync" ? (
          <SyncPanel />
        ) : (
          <AuditLogsPanel />
        )}
      </div>
    </main>
  );
}
