"use client";

import { useState } from "react";
import UpstreamsPanel from "./UpstreamsPanel";
import VirtualKeysPanel from "./VirtualKeysPanel";
import Link from "next/link";

type Tab = "upstreams" | "virtual-keys";

export default function AdminPanel() {
  const [tab, setTab] = useState<Tab>("upstreams");

  return (
    <main className="min-h-screen bg-gray-50 p-4 md:p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div className="flex items-center gap-4">
            <Link
              href="/"
              className="text-sm text-gray-400 hover:text-blue-600 transition-colors"
            >
              ← Dashboard
            </Link>
            <h1 className="text-xl md:text-3xl font-bold">Gateway Admin</h1>
          </div>
          <div className="flex rounded-md overflow-hidden border border-gray-300 bg-white">
            {(
              [
                ["upstreams", "Upstreams"],
                ["virtual-keys", "Virtual Keys"],
              ] as [Tab, string][]
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                onClick={() => setTab(id)}
                className={`px-4 py-2 text-sm font-medium transition-colors ${
                  tab === id
                    ? "bg-blue-600 text-white"
                    : "text-gray-600 hover:bg-gray-50"
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {tab === "upstreams" ? <UpstreamsPanel /> : <VirtualKeysPanel />}
      </div>
    </main>
  );
}
