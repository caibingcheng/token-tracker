"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import StatsCards, { Stats } from "./StatsCards";
import RecordsTable, { Record } from "./RecordsTable";

interface ModelStat {
  group: string;
  totalInput: number;
  totalOutput: number;
  totalInputCached: number;
  totalCacheWrite: number;
  count: number;
}

const INITIAL_INTERVAL = 60_000; // 60s
const MAX_INTERVAL = 300_000; // 5min

function formatTimeAgo(date: Date | null): string {
  if (!date) return "Never";
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return "Just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

function formatDuration(ms: number): string {
  if (ms < 60_000) return `${Math.ceil(ms / 1000)}s`;
  return `${Math.ceil(ms / 60_000)}min`;
}

export default function Dashboard() {
  // Data states
  const [stats, setStats] = useState<Stats | null>(null);
  const [topModels, setTopModels] = useState<ModelStat[]>([]);
  const [records, setRecords] = useState<Record[]>([]);
  const [recordsPage, setRecordsPage] = useState(1);
  const [recordsTotalPages, setRecordsTotalPages] = useState(1);

  // Loading states
  const [loadingStats, setLoadingStats] = useState(true);
  const [loadingTop5, setLoadingTop5] = useState(true);
  const [loadingRecords, setLoadingRecords] = useState(true);

  // Error states
  const [errorStats, setErrorStats] = useState<string | null>(null);
  const [errorTop5, setErrorTop5] = useState<string | null>(null);
  const [errorRecords, setErrorRecords] = useState<string | null>(null);

  // Polling
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [nextRefreshIn, setNextRefreshIn] = useState(INITIAL_INTERVAL);
  const [pollInterval, setPollInterval] = useState(INITIAL_INTERVAL);
  const timeoutRef = useRef<NodeJS.Timeout | null>(null);
  const lastDataRef = useRef<{ stats: string; top5: string; records: string } | null>(null);

  // Visibility
  const isVisibleRef = useRef(true);

  const fetchAll = useCallback(async () => {
    if (!isVisibleRef.current) return;

    setLoadingStats(true);
    setLoadingTop5(true);
    if (recordsPage === 1) setLoadingRecords(true);

    setErrorStats(null);
    setErrorTop5(null);
    setErrorRecords(null);

    try {
      const [statsRes, top5Res, recordsRes] = await Promise.all([
        fetch("/api/stats?groupBy=none&range=all"),
        fetch("/api/stats?groupBy=model"),
        recordsPage === 1 ? fetch(`/api/records?page=1&limit=20`) : Promise.resolve(null),
      ]);

      // Stats
      if (statsRes.ok) {
        const statsData = await statsRes.json();
        if (statsData.success && statsData.data.length > 0) {
          const item = statsData.data[0];
          setStats({
            totalInput: Number(item.totalInput || 0),
            totalOutput: Number(item.totalOutput || 0),
            totalInputCached: Number(item.totalInputCached || 0),
            totalInputUncached: Number(item.totalInputUncached || 0),
            totalCacheWrite: Number(item.totalCacheWrite || 0),
            count: Number(item.count || 0),
          });
        }
      } else {
        setErrorStats(`HTTP ${statsRes.status}`);
      }

      // Top 5
      if (top5Res.ok) {
        const top5Data = await top5Res.json();
        if (top5Data.success) {
          setTopModels(top5Data.data.slice(0, 5));
        }
      } else {
        setErrorTop5(`HTTP ${top5Res.status}`);
      }

      // Records (only page 1)
      if (recordsRes) {
        if (recordsRes.ok) {
          const recordsData = await recordsRes.json();
          if (recordsData.success) {
            setRecords(recordsData.data);
            setRecordsTotalPages(recordsData.pagination.totalPages);
          }
        } else {
          setErrorRecords(`HTTP ${recordsRes.status}`);
        }
      }

      setLastUpdated(new Date());

      // Check if data changed
      const currentData = {
        stats: JSON.stringify(stats),
        top5: JSON.stringify(topModels),
        records: JSON.stringify(records),
      };

      if (lastDataRef.current) {
        const changed =
          currentData.stats !== lastDataRef.current.stats ||
          currentData.top5 !== lastDataRef.current.top5 ||
          currentData.records !== lastDataRef.current.records;

        if (changed) {
          setPollInterval(INITIAL_INTERVAL);
        } else {
          setPollInterval((prev) => Math.min(prev * 2, MAX_INTERVAL));
        }
      }

      lastDataRef.current = currentData;
    } catch (err) {
      console.error("Fetch error:", err);
      setErrorStats("Network error");
      setErrorTop5("Network error");
      setErrorRecords("Network error");
    } finally {
      setLoadingStats(false);
      setLoadingTop5(false);
      setLoadingRecords(false);
    }
  }, [recordsPage, stats, topModels, records]);

  // Polling with dynamic interval
  useEffect(() => {
    const scheduleNext = () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
      timeoutRef.current = setTimeout(() => {
        fetchAll().then(() => {
          scheduleNext();
        });
      }, pollInterval);
    };

    // Initial fetch
    fetchAll().then(() => scheduleNext());

    return () => {
      if (timeoutRef.current) clearTimeout(timeoutRef.current);
    };
  }, [fetchAll, pollInterval]);

  // Visibility change handler
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (document.hidden) {
        isVisibleRef.current = false;
        if (timeoutRef.current) clearTimeout(timeoutRef.current);
      } else {
        isVisibleRef.current = true;
        // Immediate refresh on tab focus
        fetchAll();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [fetchAll]);

  // Countdown timer for footer
  useEffect(() => {
    const interval = setInterval(() => {
      if (!lastUpdated) return;
      const elapsed = Date.now() - lastUpdated.getTime();
      const remaining = Math.max(0, pollInterval - elapsed);
      setNextRefreshIn(remaining);
    }, 1000);

    return () => clearInterval(interval);
  }, [lastUpdated, pollInterval]);

  const formatNumber = (num: number) => new Intl.NumberFormat("en-US").format(num);

  return (
    <main className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex justify-between items-center mb-8">
          <h1 className="text-3xl font-bold">Token Tracker Dashboard</h1>
          <select
            className="px-4 py-2 border rounded-lg bg-white text-gray-700"
            disabled
            title="Range filter coming soon"
          >
            <option>All Time</option>
          </select>
        </div>

        <StatsCards stats={stats} loading={loadingStats} error={errorStats} />

        {/* Top 5 Models */}
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h2 className="text-lg font-semibold mb-1">Top 5 Models</h2>
          <p className="text-xs text-gray-400 mb-4">Input Tokens includes Cache Read</p>
          {loadingTop5 && (
            <div className="space-y-3">
              {[1, 2, 3, 4, 5].map((i) => (
                <div key={i} className="h-12 bg-gray-100 rounded animate-pulse"></div>
              ))}
            </div>
          )}
          {errorTop5 && <p className="text-red-600">Error: {errorTop5}</p>}
          {!loadingTop5 && !errorTop5 && topModels.length === 0 && (
            <p className="text-gray-500">No data available</p>
          )}
          {!loadingTop5 && !errorTop5 && topModels.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Input Tokens</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cache Read</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Output Tokens</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Cache Write</th>
                    <th className="px-4 py-3 text-right text-xs font-medium text-gray-500 uppercase">Requests</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-200">
                  {topModels.map((model) => (
                    <tr key={model.group}>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{model.group}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{formatNumber(model.totalInput)}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{formatNumber(model.totalInputCached)}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{formatNumber(model.totalOutput)}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{formatNumber(model.totalCacheWrite)}</td>
                      <td className="px-4 py-3 text-sm text-gray-600 text-right">{formatNumber(model.count)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <RecordsTable
          records={records}
          page={recordsPage}
          totalPages={recordsTotalPages}
          onPageChange={setRecordsPage}
          loading={loadingRecords}
          error={errorRecords}
        />

        {/* Footer */}
        <div className="mt-8 py-4 border-t border-gray-200 flex justify-between items-center text-sm text-gray-500">
          <span>Updated {formatTimeAgo(lastUpdated)}</span>
          <span>Next refresh in {formatDuration(nextRefreshIn)}</span>
        </div>
      </div>
    </main>
  );
}
