"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import { CopyableCode } from "./CopyableCode";

// Price Picker Modal：为指定 model 选择官方价来源（models.dev 候选 / 手动输入）

interface PriceCandidate {
  providerId: string;
  providerName: string;
  modelId: string;
  modelsDevId: string;
  inputPrice: number;
  outputPrice: number;
  cacheReadPrice: number | null;
  cacheWritePrice: number | null;
  lastUpdated: string | null;
  preferred: boolean;
}

interface PricePickerModalProps {
  isOpen: boolean;
  onClose: () => void;
  model: string;
  onSaved: () => void;
}

function fmtPrice(v: number | null): string {
  if (v === null || v === undefined) return "—";
  return `$${v.toFixed(4)}`;
}

export default function PricePickerModal({
  isOpen,
  onClose,
  model,
  onSaved,
}: PricePickerModalProps) {
  const [candidates, setCandidates] = useState<PriceCandidate[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  // 手动输入区
  const [showManual, setShowManual] = useState(false);
  const [manualInput, setManualInput] = useState("");
  const [manualOutput, setManualOutput] = useState("");
  const [manualCacheRead, setManualCacheRead] = useState("");
  const [manualCacheWrite, setManualCacheWrite] = useState("");
  const [manualSaving, setManualSaving] = useState(false);

  useEffect(() => {
    if (!isOpen) return;
    setLoading(true);
    setError(null);
    setShowManual(false);
    setManualInput("");
    setManualOutput("");
    setManualCacheRead("");
    setManualCacheWrite("");
    apiFetch(`/api/admin/model-prices/candidates?model=${encodeURIComponent(model)}`)
      .then(async (res) => {
        const json = await res.json();
        if (json.success) {
          setCandidates(json.data);
        } else {
          setError(json.error || "Failed to load candidates");
        }
      })
      .catch(() => setError("Network error"))
      .finally(() => setLoading(false));
  }, [isOpen, model]);

  if (!isOpen) return null;

  const pick = async (c: PriceCandidate) => {
    setSaving(c.modelsDevId);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/model-prices/select", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model, modelsDevId: c.modelsDevId }),
      });
      const json = await res.json();
      if (json.success) {
        onSaved();
        onClose();
      } else {
        setError(json.error || "Failed to save price");
      }
    } catch {
      setError("Network error");
    } finally {
      setSaving(null);
    }
  };

  const saveManual = async () => {
    const inputPrice = Number(manualInput);
    const outputPrice = Number(manualOutput);
    if (!Number.isFinite(inputPrice) || inputPrice < 0 || !Number.isFinite(outputPrice) || outputPrice < 0) {
      setError("Input/Output price must be non-negative numbers");
      return;
    }
    const parseOpt = (v: string): number | null =>
      v.trim() === "" ? null : Number(v);
    const cacheReadPrice = parseOpt(manualCacheRead);
    const cacheWritePrice = parseOpt(manualCacheWrite);
    if (
      (cacheReadPrice !== null && (!Number.isFinite(cacheReadPrice) || cacheReadPrice < 0)) ||
      (cacheWritePrice !== null && (!Number.isFinite(cacheWritePrice) || cacheWritePrice < 0))
    ) {
      setError("Cache prices must be non-negative numbers");
      return;
    }
    setManualSaving(true);
    setError(null);
    try {
      const res = await apiFetch("/api/admin/model-prices", {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model,
          inputPrice,
          outputPrice,
          cacheReadPrice,
          cacheWritePrice,
        }),
      });
      const json = await res.json();
      if (json.success) {
        onSaved();
        onClose();
      } else {
        setError(json.error || "Failed to save price");
      }
    } catch {
      setError("Network error");
    } finally {
      setManualSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 md:p-4">
      <div className="w-full h-full md:h-auto md:w-full md:max-w-3xl md:max-h-[90vh] md:rounded-lg bg-white shadow-xl flex flex-col">
        <div className="flex items-start justify-between gap-2 border-b border-gray-200 p-4">
          <div className="min-w-0">
            <h3 className="text-base font-semibold">Select Price</h3>
            <div className="mt-1 flex items-center gap-2">
              <CopyableCode className="rounded bg-gray-100 px-1.5 py-0.5 text-xs">
                {model}
              </CopyableCode>
              <span className="text-[11px] text-gray-400">
                Official price reference (USD / 1M tokens)
              </span>
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="shrink-0 rounded p-2 text-gray-400 hover:bg-gray-100 hover:text-gray-600 min-w-[40px] min-h-[40px] md:min-w-0 md:min-h-0"
          >
            ✕
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-4">
          {error && (
            <div className="mb-3 rounded border border-red-200 bg-red-50 p-3 text-sm text-red-600">
              {error}
            </div>
          )}

          {loading ? (
            <div className="py-8 text-center text-sm text-gray-400">Loading candidates…</div>
          ) : candidates.length === 0 ? (
            <div className="py-8 text-center text-sm text-gray-400">
              No models.dev candidates found for this model.
            </div>
          ) : (
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-left text-xs text-gray-400">
                    <th className="px-2 py-2">Provider</th>
                    <th className="px-2 py-2">Model</th>
                    <th className="px-2 py-2 text-right">Input</th>
                    <th className="px-2 py-2 text-right">Output</th>
                    <th className="px-2 py-2 text-right">Cache Read</th>
                    <th className="px-2 py-2 text-right">Cache Write</th>
                    <th className="px-2 py-2"></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {candidates.map((c) => (
                    <tr key={c.modelsDevId} className={c.preferred ? "bg-green-50/40" : ""}>
                      <td className="px-2 py-2">
                        <div className="flex items-center gap-1.5">
                          <span className="font-medium">{c.providerName}</span>
                          {c.preferred && (
                            <span className="rounded bg-green-100 px-1 py-0.5 text-[10px] font-medium text-green-700">
                              preferred
                            </span>
                          )}
                        </div>
                      </td>
                      <td className="px-2 py-2">
                        <CopyableCode className="text-xs">{c.modelId}</CopyableCode>
                      </td>
                      <td className="px-2 py-2 text-right font-mono text-xs">{fmtPrice(c.inputPrice)}</td>
                      <td className="px-2 py-2 text-right font-mono text-xs">{fmtPrice(c.outputPrice)}</td>
                      <td className="px-2 py-2 text-right font-mono text-xs">{fmtPrice(c.cacheReadPrice)}</td>
                      <td className="px-2 py-2 text-right font-mono text-xs">{fmtPrice(c.cacheWritePrice)}</td>
                      <td className="px-2 py-2 text-right">
                        <button
                          type="button"
                          disabled={saving !== null}
                          onClick={() => pick(c)}
                          className="rounded bg-blue-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-blue-700 disabled:opacity-50 min-h-[36px] md:min-h-0"
                        >
                          {saving === c.modelsDevId ? "Saving…" : "Use"}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* 移动端候选卡片 */}
          {!loading && candidates.length > 0 && (
            <div className="md:hidden space-y-3">
              {candidates.map((c) => (
                <div
                  key={c.modelsDevId}
                  className={`border rounded-lg p-3 ${c.preferred ? "border-green-200 bg-green-50/40" : "border-gray-200"}`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-sm font-medium">{c.providerName}</p>
                      <CopyableCode className="text-xs">{c.modelId}</CopyableCode>
                    </div>
                    {c.preferred && (
                      <span className="shrink-0 rounded bg-green-100 px-1.5 py-0.5 text-[10px] font-medium text-green-700">
                        preferred
                      </span>
                    )}
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-gray-600">
                    <span>Input <span className="float-right font-mono">{fmtPrice(c.inputPrice)}</span></span>
                    <span>Output <span className="float-right font-mono">{fmtPrice(c.outputPrice)}</span></span>
                    <span>Cache Rd <span className="float-right font-mono">{fmtPrice(c.cacheReadPrice)}</span></span>
                    <span>Cache Wr <span className="float-right font-mono">{fmtPrice(c.cacheWritePrice)}</span></span>
                  </div>
                  <button
                    type="button"
                    disabled={saving !== null}
                    onClick={() => pick(c)}
                    className="mt-3 w-full rounded bg-blue-600 px-3 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
                  >
                    {saving === c.modelsDevId ? "Saving…" : "Use this price"}
                  </button>
                </div>
              ))}
            </div>
          )}

          {/* 手动输入折叠区 */}
          <div className="mt-4 rounded border border-gray-200">
            <button
              type="button"
              onClick={() => setShowManual(!showManual)}
              className="flex w-full items-center justify-between px-3 py-2.5 text-sm font-medium text-gray-700 hover:bg-gray-50 min-h-[40px] md:min-h-0"
            >
              <span>Manual input</span>
              <span className="text-xs text-gray-400">{showManual ? "▲" : "▼"}</span>
            </button>
            {showManual && (
              <div className="border-t border-gray-200 p-3">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">Input (USD / 1M)</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={manualInput}
                      onChange={(e) => setManualInput(e.target.value)}
                      className="w-full rounded border border-gray-300 px-3 py-2 text-base md:text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="e.g. 3"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">Output (USD / 1M)</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={manualOutput}
                      onChange={(e) => setManualOutput(e.target.value)}
                      className="w-full rounded border border-gray-300 px-3 py-2 text-base md:text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="e.g. 15"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">Cache Read (optional)</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={manualCacheRead}
                      onChange={(e) => setManualCacheRead(e.target.value)}
                      className="w-full rounded border border-gray-300 px-3 py-2 text-base md:text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="Empty = input price"
                    />
                  </div>
                  <div>
                    <label className="mb-1 block text-xs font-medium text-gray-700">Cache Write (optional)</label>
                    <input
                      type="number"
                      min="0"
                      step="any"
                      value={manualCacheWrite}
                      onChange={(e) => setManualCacheWrite(e.target.value)}
                      className="w-full rounded border border-gray-300 px-3 py-2 text-base md:text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
                      placeholder="Empty = input price"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={manualSaving}
                  onClick={saveManual}
                  className="mt-3 w-full rounded bg-gray-800 px-4 py-2 text-sm font-medium text-white hover:bg-gray-900 disabled:opacity-50 md:w-auto"
                >
                  {manualSaving ? "Saving…" : "Save as manual price"}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
