import { formatNumber } from "@/lib/number-utils";

export interface QuotaUsageData {
  rpm: number;
  tpm: number;
  dailyTokens: number;
  monthlyTokens: number;
}

export interface QuotaLimitsData {
  maxRpm: number | null;
  maxTpm: number | null;
  maxDailyTokens: number | null;
  maxMonthlyTokens: number | null;
}

// 颜色分级：<50% 蓝 / ≥50% 黄 / ≥80% 橙 / ≥100% 红
function ratioColor(ratio: number): string {
  if (ratio >= 1) return "bg-red-500";
  if (ratio >= 0.8) return "bg-orange-500";
  if (ratio >= 0.5) return "bg-yellow-500";
  return "bg-blue-500";
}

function formatQuota(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// 完整进度条（Usage 展开面板）：label + current/limit (xx%) + 进度条；limit null 显示 ∞
export function QuotaBar({
  label,
  current,
  limit,
}: {
  label: string;
  current: number;
  limit: number | null;
}) {
  if (limit == null) {
    return (
      <div className="rounded border border-gray-100 bg-gray-50/60 p-2">
        <div className="flex items-baseline justify-between gap-2 text-xs">
          <span className="font-medium text-gray-500">{label}</span>
          <span className="text-gray-400">∞</span>
        </div>
      </div>
    );
  }
  const ratio = current / limit;
  const pct = Math.min(100, Math.round(ratio * 100));
  return (
    <div className="rounded border border-gray-100 bg-gray-50/60 p-2">
      <div className="flex items-baseline justify-between gap-2 text-xs">
        <span className="font-medium text-gray-500">{label}</span>
        <span className="tabular-nums text-gray-700">
          <span className={ratio >= 1 ? "font-semibold text-red-600" : undefined}>
            {formatNumber(current, true)}
          </span>
          <span className="text-gray-400"> / {formatQuota(limit)} ({pct}%)</span>
        </span>
      </div>
      <div className="mt-1.5 h-1.5 w-full rounded-full bg-gray-200">
        <div
          className={`h-1.5 rounded-full transition-all ${ratioColor(ratio)}`}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
    </div>
  );
}

// 紧凑迷你进度条（列表行）：label + 条 + 百分比；title 显示完整 current / limit
export function MiniQuotaBar({
  label,
  current,
  limit,
}: {
  label: string;
  current: number;
  limit: number;
}) {
  const ratio = current / limit;
  const pct = Math.min(100, Math.round(ratio * 100));
  return (
    <div
      className="flex items-center gap-1.5"
      title={`${label}: ${formatNumber(current, true)} / ${formatQuota(limit)} (${pct}%)`}
    >
      <span className="w-11 shrink-0 text-[10px] text-gray-500">{label}</span>
      <div className="h-1.5 w-14 shrink-0 rounded-full bg-gray-200">
        <div
          className={`h-1.5 rounded-full ${ratioColor(ratio)}`}
          style={{ width: `${Math.max(pct, 2)}%` }}
        />
      </div>
      <span className={`text-[10px] tabular-nums ${ratio >= 1 ? "font-semibold text-red-600" : "text-gray-600"}`}>
        {pct}%
      </span>
    </div>
  );
}
