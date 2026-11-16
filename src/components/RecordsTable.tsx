"use client";

import { useEffect, useRef, useState } from "react";
import { formatNumber, formatFullNumber, formatLatencyMs } from "@/lib/number-utils";
import { useNumberFormat } from "./NumberFormatContext";
import { apiFetch } from "@/lib/client/api-client";
import { DEFAULT_RECORD_COLUMNS, type RecordColumnId } from "@/lib/records-columns";

export interface Record {
  id: number;
  model: string;
  normalizedModel: string;
  providerName?: string | null;
  agent: string;
  userAgent?: string | null;
  keyName: string;
  inputTokens: number;
  outputTokens: number;
  cacheRead: number;
  cacheWrite: number;
  requestModel?: string | null;
  sessionId?: string | null;
  latencyMs?: number | null;
  ttftMs?: number | null;
  status?: string | null;
  createdAt: string;
}

interface RecordsTableProps {
  selectedProvider?: string;
  selectedModel?: string;
  selectedAgent?: string;
  pageSize?: number;
  autoRefresh?: boolean;
  refreshKey?: number;
  visibleColumns?: RecordColumnId[];
  onRefreshingChange?: (refreshing: boolean) => void;
}

const AUTO_REFRESH_INTERVAL_MS = 15000;
const DEFAULT_PAGE_SIZE = 100;

function StatusBadge({ status }: { status?: string | null }) {
  if (!status) return <span className="text-gray-400">-</span>;
  switch (status) {
    case "classifier":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-indigo-100 text-indigo-800">
          Classifier
        </span>
      );
    case "no_usage":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-amber-100 text-amber-800">
          No usage
        </span>
      );
    case "estimated":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-blue-100 text-blue-800">
          Estimated
        </span>
      );
    case "client_aborted":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-red-100 text-red-800">
          Client aborted
        </span>
      );
    case "stream_interrupted":
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-orange-100 text-orange-800">
          Stream interrupted
        </span>
      );
    default:
      return (
        <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-gray-100 text-gray-800">
          {status}
        </span>
      );
  }
}

interface PagerButtonProps {
  onClick: () => void;
  disabled: boolean;
  label: string;
  children: React.ReactNode;
}

function PagerButton({ onClick, disabled, label, children }: PagerButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={label}
      aria-label={label}
      className="px-2 py-2 text-gray-700 bg-gray-100 rounded disabled:opacity-50 flex items-center justify-center min-h-[40px] min-w-[40px] md:min-h-0 md:min-w-0"
    >
      {children}
    </button>
  );
}

function IconFirst() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="19 20 9 12 19 4 19 20"/>
      <line x1="5" y1="19" x2="5" y2="5"/>
    </svg>
  );
}

function IconLast() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polygon points="5 4 15 12 5 20 5 4"/>
      <line x1="19" y1="5" x2="19" y2="19"/>
    </svg>
  );
}

function IconPrev() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="15 18 9 12 15 6"/>
    </svg>
  );
}

function IconNext() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"/>
    </svg>
  );
}

function ChevronDownIcon() {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9"/>
    </svg>
  );
}

export default function RecordsTable({
  selectedProvider = "all",
  selectedModel = "all",
  selectedAgent = "all",
  pageSize = DEFAULT_PAGE_SIZE,
  autoRefresh = false,
  refreshKey = 0,
  visibleColumns = DEFAULT_RECORD_COLUMNS,
  onRefreshingChange,
}: RecordsTableProps) {
  const [records, setRecords] = useState<Record[]>([]);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pageInput, setPageInput] = useState("1");
  // 移动端卡片展开的明细行（一次只展开一条，避免长列表滚动过长）
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [queryKey, setQueryKey] = useState(0);
  const { compact } = useNumberFormat();
  const visibleSet = new Set(visibleColumns);
  const show = (column: RecordColumnId) => visibleSet.has(column);

  // 首次加载才切换骨架屏；后续刷新（手动 / 自动）保持表格挂载，静默替换数据
  const loadedOnceRef = useRef(false);
  // 请求序号：慢响应晚到时不覆盖更新的结果
  const requestSeqRef = useRef(0);
  // 刷新中状态上抛：Refresh 按钮已搬到页面顶栏，需要按钮侧反馈
  useEffect(() => {
    onRefreshingChange?.(refreshing);
  }, [refreshing, onRefreshingChange]);

  // 筛选或行数变化就回到第 1 页：在 render 阶段同步 state（React 会丢弃本次渲染并立即重渲染），
  // 避免「条件变化 → 先用旧页码请求一次 → reset effect 再请求一次」的重复请求
  const conditionKey = `${selectedProvider}|${selectedModel}|${selectedAgent}|${pageSize}`;
  const [lastConditionKey, setLastConditionKey] = useState(conditionKey);
  if (lastConditionKey !== conditionKey) {
    setLastConditionKey(conditionKey);
    setPage(1);
  }

  // 自动刷新（15s），页面不可见时跳过
  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      setQueryKey((k) => k + 1);
    }, AUTO_REFRESH_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [autoRefresh]);

  // Fetch records（认证由 ApiKeyGate/api-client 统一处理，401 自动回输入页）
  useEffect(() => {
    const seq = ++requestSeqRef.current;
    if (loadedOnceRef.current) {
      setRefreshing(true);
    } else {
      setLoading(true);
    }
    setError(null);

    const url = new URL("/api/records", window.location.origin);
    url.searchParams.set("page", String(page));
    url.searchParams.set("limit", String(pageSize));
    if (selectedProvider !== "all") {
      url.searchParams.set("provider", selectedProvider);
    }
    if (selectedModel !== "all") {
      url.searchParams.set("model", selectedModel);
    }
    if (selectedAgent !== "all") {
      url.searchParams.set("agent", selectedAgent);
    }

    apiFetch(url.toString())
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((result) => {
        if (seq !== requestSeqRef.current) return;
        if (result.success) {
          loadedOnceRef.current = true;
          const nextTotalPages = Math.max(1, Number(result.pagination?.totalPages) || 1);
          setTotalPages(nextTotalPages);
          // 页码越界（数据被删除/过滤后总页数收缩）时回到末页重取
          if (page > nextTotalPages) {
            setPage(nextTotalPages);
            return;
          }
          setRecords(result.data);
        } else {
          setError(result.error || "Failed to load records");
        }
      })
      .catch((err) => {
        if (seq !== requestSeqRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seq !== requestSeqRef.current) return;
        setLoading(false);
        setRefreshing(false);
      });
  }, [page, queryKey, pageSize, refreshKey, selectedProvider, selectedModel, selectedAgent]);

  useEffect(() => {
    setPageInput(String(page));
  }, [page]);

  const formatDate = (date: string) => new Date(date).toLocaleString();
  // 移动端卡片用短格式（M/d HH:mm），完整时间走 title
  const formatShortDate = (date: string) =>
    new Date(date).toLocaleString(undefined, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  // Date 显示本地时间，hover 给 ISO（与 upstream 日志/运营侧对时间用）
  const dateTitle = (date: string) => {
    const d = new Date(date);
    return Number.isNaN(d.getTime()) ? String(date) : d.toISOString();
  };
  // TTFT / Latency 显示 `123ms` / `1.2s`，hover 精确到毫秒
  const latencyTitle = (ms: number | null | undefined) =>
    ms === null || ms === undefined || !Number.isFinite(ms) ? "-" : `${Math.round(ms)}ms`;

  // Model 列只显示原始名（发往 upstream 的真实 model 名），hover 才看 manual 名（alias 归一后的展示名）与
  // 客户端原始请求名（命名路由虚拟名）
  const modelTitle = (record: Record): string => {
    const lines: string[] = [];
    if (record.normalizedModel && record.normalizedModel !== record.model) {
      lines.push(`Manual: ${record.normalizedModel}`);
    }
    lines.push(`Raw: ${record.model}`);
    if (record.requestModel && record.requestModel !== record.model) {
      lines.push(`Requested: ${record.requestModel}`);
    }
    return lines.join("\n");
  };

  // Agent 列显示派生工具名（按 user_agent 解析），hover 才看原始 UA 与 Key（agent 列原值）
  const agentTitle = (record: Record): string =>
    [
      `Agent: ${record.agent}`,
      `User-Agent: ${record.userAgent?.trim() || "-"}`,
      `Key: ${record.keyName || "-"}`,
    ].join("\n");

  // Tokens 列：`in / out · xx% cached`（in = uncached + cache，口径对齐"Total Input 含 cache"），
  // 完整明细走 hover（同 LiteLLM / Langfuse 的单列 + 明细约定）
  const promptTotal = (record: Record) => record.inputTokens + record.cacheRead;
  const cacheRate = (record: Record): number | null => {
    const total = promptTotal(record);
    return total > 0 ? (record.cacheRead / total) * 100 : null;
  };
  const tokensText = (record: Record): string => {
    const base = `${formatNumber(promptTotal(record), compact)} / ${formatNumber(record.outputTokens, compact)}`;
    const rate = cacheRate(record);
    return rate === null ? base : `${base} · ${Math.round(rate)}%`;
  };
  const tokensTitle = (record: Record): string => {
    const rate = cacheRate(record);
    const lines = [
      `Prompt: ${formatFullNumber(promptTotal(record))}`,
      `  uncached: ${formatFullNumber(record.inputTokens)}`,
      `  cached: ${formatFullNumber(record.cacheRead)}`,
      `Cache rate: ${rate === null ? "-" : `${rate.toFixed(1)}%`}`,
      `Output: ${formatFullNumber(record.outputTokens)}`,
    ];
    // cache write 只有 Anthropic 系 prompt caching 会产生，绝大多数行为 0，非零才展示
    if (record.cacheWrite > 0) {
      lines.push(`Cache write: ${formatFullNumber(record.cacheWrite)}`);
    }
    return lines.join("\n");
  };

  const commitPageInput = () => {
    const parsed = parseInt(pageInput, 10);
    if (!Number.isFinite(parsed)) {
      setPageInput(String(page));
      return;
    }
    const next = Math.min(Math.max(1, parsed), totalPages);
    setPageInput(String(next));
    if (next !== page) {
      setPage(next);
    }
  };

  const isFirstPage = page <= 1;
  const isLastPage = page >= totalPages;
  const hasRecords = records.length > 0;
  // 输入框宽度按最大页码位数自适应（位数 + 2ch 余量）
  const pageInputWidth = `${Math.max(String(totalPages).length + 2, 4)}ch`;

  return (
    <div className="md:bg-white md:rounded-lg md:shadow md:overflow-hidden">
      {error && hasRecords && (
        <div className="mx-4 md:mx-6 mt-3 px-3 py-2 rounded border border-red-200 bg-red-50 text-sm text-red-700">
          Refresh failed: {error}
        </div>
      )}

      {loading ? (
        <>
          <div className="hidden md:block p-6">
            <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
            <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
            <div className="h-4 bg-gray-200 rounded w-full mb-4 animate-pulse"></div>
          </div>
          {/* 移动端骨架屏与卡片同形（白卡 + 两行文本 + 三列数值） */}
          <div className="space-y-3 md:hidden">
            {[1, 2, 3, 4].map((i) => (
              <div key={i} className="animate-pulse rounded-xl bg-white p-4 shadow-sm ring-1 ring-gray-100">
                <div className="h-4 w-2/3 rounded bg-gray-200" />
                <div className="mt-2 h-3 w-1/2 rounded bg-gray-100" />
                <div className="mt-3 grid grid-cols-3 gap-2">
                  <div className="h-8 rounded bg-gray-100" />
                  <div className="h-8 rounded bg-gray-100" />
                  <div className="h-8 rounded bg-gray-100" />
                </div>
              </div>
            ))}
          </div>
        </>
      ) : error && !hasRecords ? (
        <div className="p-6">
          <p className="text-red-600">Error: {error}</p>
        </div>
      ) : (
        <>
          <div className="hidden md:block overflow-x-auto">
            <table className="w-full">
              <thead className="bg-gray-50">
                <tr>
                  {show("date") && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Date</th>
                  )}
                  {show("model") && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Model</th>
                  )}
                  {show("provider") && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Provider</th>
                  )}
                  {show("agent") && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Agent</th>
                  )}
                  {show("key") && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Key</th>
                  )}
                  {show("session") && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Session</th>
                  )}
                  {show("tokens") && (
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Tokens</th>
                  )}
                  {show("ttft") && (
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">TTFT</th>
                  )}
                  {show("latency") && (
                    <th className="px-6 py-3 text-right text-xs font-medium text-gray-500 uppercase">Latency</th>
                  )}
                  {show("status") && (
                    <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
                  )}
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200">
                {records.map((record) => (
                  <tr key={record.id}>
                    {show("date") && (
                      <td
                        className="px-6 py-4 whitespace-nowrap text-sm text-gray-900"
                        title={dateTitle(record.createdAt)}
                      >
                        {formatDate(record.createdAt)}
                      </td>
                    )}
                    {show("model") && (
                    <td
                      className="px-6 py-4 whitespace-nowrap text-sm text-gray-900"
                      title={modelTitle(record)}
                    >
                      {record.model}
                    </td>
                    )}
                    {show("provider") && (
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900">
                      {record.providerName || "-"}
                    </td>
                    )}
                    {show("agent") && (
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-900" title={agentTitle(record)}>
                      {record.agent}
                    </td>
                    )}
                    {show("key") && (
                    <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                      {record.keyName || "-"}
                    </td>
                    )}
                    {show("session") && (
                    <td
                      className="px-6 py-4 whitespace-nowrap text-sm text-gray-500 font-mono"
                      title={record.sessionId ?? undefined}
                    >
                      {record.sessionId ? (
                        <span className="inline-block max-w-[140px] truncate align-bottom">
                          {record.sessionId}
                        </span>
                      ) : (
                        "-"
                      )}
                    </td>
                    )}
                    {show("tokens") && (
                    <td
                      className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right"
                      title={tokensTitle(record)}
                    >
                      <span className="tabular-nums">{tokensText(record)}</span>
                    </td>
                    )}
                    {show("ttft") && (
                    <td
                      className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right"
                      title={latencyTitle(record.ttftMs)}
                    >
                      {formatLatencyMs(record.ttftMs)}
                    </td>
                    )}
                    {show("latency") && (
                    <td
                      className="px-6 py-4 whitespace-nowrap text-sm text-gray-900 text-right"
                      title={latencyTitle(record.latencyMs)}
                    >
                      {formatLatencyMs(record.latencyMs)}
                    </td>
                    )}
                    {show("status") && (
                    <td className="px-6 py-4 whitespace-nowrap text-sm">
                      <StatusBadge status={record.status} />
                    </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* 移动端卡片：模型/状态 + 元信息 + 三列数值 + 延迟，点开看完整明细。
              移动端没有 hover，所以 Session / Key / 原始 UA / request 名必须可展开，不能再只靠 title */}
          <div className="md:hidden space-y-3">
            {records.map((record) => {
              const rate = cacheRate(record);
              const expanded = expandedId === record.id;
              const metaParts: string[] = [];
              if (show("date")) metaParts.push(formatShortDate(record.createdAt));
              if (show("provider")) metaParts.push(record.providerName || "-");
              if (show("agent")) metaParts.push(record.agent);

              const details: Array<{ label: string; value: string; breakAll?: boolean }> = [];
              if (show("model")) {
                if (record.normalizedModel && record.normalizedModel !== record.model) {
                  details.push({ label: "Manual", value: record.normalizedModel });
                }
                if (record.requestModel && record.requestModel !== record.model) {
                  details.push({ label: "Requested", value: record.requestModel });
                }
              }
              if (show("key")) details.push({ label: "Key", value: record.keyName || "-" });
              if (show("agent")) {
                details.push({ label: "User-Agent", value: record.userAgent?.trim() || "-" });
              }
              if (show("tokens")) {
                details.push({ label: "Prompt", value: formatFullNumber(promptTotal(record)) });
                details.push({ label: "Uncached", value: formatFullNumber(record.inputTokens) });
                details.push({ label: "Cached", value: formatFullNumber(record.cacheRead) });
                if (record.cacheWrite > 0) {
                  details.push({ label: "Cache write", value: formatFullNumber(record.cacheWrite) });
                }
                details.push({ label: "Output", value: formatFullNumber(record.outputTokens) });
              }
              if (show("ttft")) details.push({ label: "TTFT", value: latencyTitle(record.ttftMs) });
              if (show("latency")) details.push({ label: "Latency", value: latencyTitle(record.latencyMs) });
              if (show("session")) {
                details.push({ label: "Session", value: record.sessionId || "-", breakAll: true });
              }
              if (show("date")) {
                details.push({ label: "Time", value: dateTitle(record.createdAt), breakAll: true });
              }
              return (
                <div key={record.id} className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-100">
                  <button
                    type="button"
                    onClick={() => setExpandedId(expanded ? null : record.id)}
                    aria-expanded={expanded}
                    className="w-full p-4 text-left active:bg-gray-50"
                  >
                    {(show("model") || show("status")) && (
                      <span className="flex items-start justify-between gap-2">
                        {show("model") ? (
                          <span className="min-w-0 truncate text-sm font-semibold text-gray-900">
                            {record.model}
                          </span>
                        ) : (
                          <span />
                        )}
                        {show("status") && <StatusBadge status={record.status} />}
                      </span>
                    )}
                    {metaParts.length > 0 && (
                      <span className="mt-1 block truncate text-xs text-gray-500">
                        {metaParts.join(" · ")}
                      </span>
                    )}
                    {show("tokens") && (
                      <span className="mt-3 grid grid-cols-3 gap-2">
                        <span className="block">
                          <span className="block text-[11px] uppercase text-gray-400">In</span>
                          <span className="block text-sm font-semibold tabular-nums text-gray-900">
                            {formatNumber(promptTotal(record), compact)}
                          </span>
                        </span>
                        <span className="block">
                          <span className="block text-[11px] uppercase text-gray-400">Out</span>
                          <span className="block text-sm font-semibold tabular-nums text-gray-900">
                            {formatNumber(record.outputTokens, compact)}
                          </span>
                        </span>
                        <span className="block">
                          <span className="block text-[11px] uppercase text-gray-400">Cache</span>
                          <span className="block text-sm font-semibold tabular-nums text-gray-900">
                            {rate === null ? "-" : `${Math.round(rate)}%`}
                          </span>
                        </span>
                      </span>
                    )}
                    {(show("ttft") || show("latency") || details.length > 0) && (
                      <span className="mt-2 flex items-center justify-between gap-2 text-xs tabular-nums text-gray-500">
                        <span>
                          {show("ttft") && <>TTFT {formatLatencyMs(record.ttftMs)}</>}
                          {show("ttft") && show("latency") && " · "}
                          {show("latency") && <>Latency {formatLatencyMs(record.latencyMs)}</>}
                        </span>
                        {details.length > 0 && (
                          <span
                            className={`shrink-0 text-gray-400 transition-transform ${
                              expanded ? "rotate-180" : ""
                            }`}
                          >
                            <ChevronDownIcon />
                          </span>
                        )}
                      </span>
                    )}
                  </button>
                  {expanded && details.length > 0 && (
                    <div className="space-y-1.5 border-t border-gray-100 bg-gray-50/60 px-4 py-3">
                      {details.map((detail) => (
                        <div key={detail.label} className="flex items-start justify-between gap-3 text-xs">
                          <span className="shrink-0 text-gray-400">{detail.label}</span>
                          <span
                            className={`min-w-0 text-right font-medium text-gray-700 ${
                              detail.breakAll ? "break-all font-mono" : "break-words"
                            }`}
                          >
                            {detail.value}
                          </span>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* 移动端分页：prev / 页码 / next（first+prev+input+next+last 在 360px 下换行错位） */}
          <div className="flex items-center justify-between gap-2 border-t border-gray-200 px-1 py-3 md:hidden">
            <PagerButton
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={isFirstPage}
              label="Previous page"
            >
              <IconPrev />
            </PagerButton>
            <span className="flex items-center gap-1 text-sm text-gray-600">
              Page
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={pageInput}
                onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    commitPageInput();
                  }
                }}
                onBlur={commitPageInput}
                aria-label="Page number"
                title="Jump to page"
                style={{ width: pageInputWidth }}
                className="h-10 px-0 text-center text-base tabular-nums border border-gray-200 rounded bg-gray-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              of <span className="tabular-nums">{totalPages}</span>
            </span>
            <PagerButton
              onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
              disabled={isLastPage}
              label="Next page"
            >
              <IconNext />
            </PagerButton>
          </div>

          <div className="hidden md:block px-4 md:px-6 py-4 border-t">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <span className="text-sm text-gray-600">
                Page {page} of {totalPages}
              </span>
              <div className="flex items-center gap-2">
                <PagerButton onClick={() => setPage(1)} disabled={isFirstPage} label="First page">
                  <IconFirst />
                </PagerButton>
                <PagerButton onClick={() => setPage((p) => Math.max(1, p - 1))} disabled={isFirstPage} label="Previous page">
                  <IconPrev />
                </PagerButton>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  value={pageInput}
                  onChange={(e) => setPageInput(e.target.value.replace(/[^0-9]/g, ""))}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      commitPageInput();
                    }
                  }}
                  onBlur={commitPageInput}
                  aria-label="Page number"
                  title="Jump to page"
                  style={{ width: pageInputWidth }}
                  className="h-10 md:h-8 px-0 text-base md:text-sm text-center tabular-nums border border-gray-200 rounded bg-gray-50 focus:outline-none focus:ring-1 focus:ring-blue-500"
                />
                <PagerButton onClick={() => setPage((p) => Math.min(totalPages, p + 1))} disabled={isLastPage} label="Next page">
                  <IconNext />
                </PagerButton>
                <PagerButton onClick={() => setPage(totalPages)} disabled={isLastPage} label="Last page">
                  <IconLast />
                </PagerButton>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
