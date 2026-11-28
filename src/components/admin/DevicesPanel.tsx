"use client";

// Admin Devices tab：relay（sub node）设备管理。
// - 配对：输 8 位码（一码一格）→ 直接授权（码是中心生成的 8 位码，relay 只负责展示）
// - 列表：改名 / 撤销 / 解除撤销 / 删除（删设备不删历史记录，device_id 置 NULL）
// - 统计：待授权配对数、预留泄漏计数（relay_gap_count）、plan/report 每分钟速率
// 约定：桌面 table + md:hidden 卡片双轨，触摸区 ≥40px（见 components/admin/table.tsx）。

import { Fragment, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import {
  AdminMobileCard,
  AdminMobileCards,
  AdminTable,
  AdminTableBody,
  AdminTableCard,
  AdminTableHead,
  AdminTd,
} from "./table";
import { linkAction, pillAction, statusChip, tapAction } from "./buttons";
import { useConfirm } from "./ConfirmDialog";

interface RttStatsView {
  latestMs: number | null;
  avgMs: number | null;
  maxMs: number | null;
  samples: number;
}

interface DeviceItem {
  id: number;
  fingerprint: string;
  name: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  status: "pending" | "active" | "revoked";
  recordCount30d: number;
  latency: { plan: RttStatsView; report: RttStatsView };
}

interface Stats {
  pendingPairings: number;
  relayGapCount: number;
  plansLastMinute: number;
  reportsLastMinute: number;
  devices: number;
  activeDevices: number;
}

/** 配对码长度（ABCD-EFGH：8 位，字符集排除 0 O I 1，连字符只用于展示） */
const CODE_LENGTH = 8;

function formatDate(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString();
  } catch {
    return "—";
  }
}

function shortFingerprint(fingerprint: string): string {
  return fingerprint.slice(0, 8);
}

function formatRtt(ms: number | null): string {
  if (ms === null) return "—";
  return ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`;
}

// 5h 汇总：最新 / 平均 / 最大。不做折线图 —— 个人使用下大多数分钟没有样本，
// 稀疏散点的信息量不如三个数字（要趋势时直接看数字变化）。
function RttCell({ plan, report }: { plan: RttStatsView; report: RttStatsView }) {
  const title = `report RTT — latest ${formatRtt(report.latestMs)} · avg ${formatRtt(
    report.avgMs
  )} · max ${formatRtt(report.maxMs)}`;
  return (
    <div title={title}>
      <span className="font-mono text-gray-900">{formatRtt(plan.latestMs)}</span>
      <p className="text-xs text-gray-500">
        avg {formatRtt(plan.avgMs)} · max {formatRtt(plan.maxMs)}
      </p>
    </div>
  );
}

const STATUS_LABEL: Record<DeviceItem["status"], string> = {
  pending: "pending",
  active: "active",
  revoked: "revoked",
};

export default function DevicesPanel() {
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  // 配对码：一码一格（粘贴 / 输错 / 退格都在格间移动）
  const [digits, setDigits] = useState<string[]>(() => Array(CODE_LENGTH).fill(""));
  const digitRefs = useRef<Array<HTMLInputElement | null>>([]);
  const code = digits.join("");
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  // 行内改名
  const [renameId, setRenameId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const [listRes, statsRes] = await Promise.all([
        apiFetch("/api/admin/devices"),
        apiFetch("/api/admin/devices/stats"),
      ]);
      const listBody = (await listRes.json()) as { success?: boolean; data?: DeviceItem[]; error?: string };
      const statsBody = (await statsRes.json()) as { success?: boolean; data?: Stats };
      if (!listRes.ok || !listBody.success) {
        setError(listBody.error ?? "Failed to load devices");
      } else {
        setDevices(listBody.data ?? []);
        setError(null);
      }
      if (statsRes.ok && statsBody.success) setStats(statsBody.data ?? null);
    } catch {
      setError("Failed to load devices");
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 列表自动刷新（15s）：relay 拿到 token 后状态从 pending 变 active，不用手动刷页。
  // 页面不可见时跳过。没有更快的轮询需求了 —— 配对靠输码，不靠待授权列表推送。
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      timer = setTimeout(async () => {
        if (cancelled) return;
        if (typeof document === "undefined" || document.visibilityState === "visible") {
          await load({ silent: true });
        }
        schedule();
      }, 15_000);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  function applyChars(start: number, raw: string) {
    const chars = raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const next = [...digits];
    if (chars.length === 0) {
      // 当前格被删空（Backspace，或选中后键入了非法字符）：只清空，不移动焦点。
      // 以前这里直接 return，导致输入框被 React 受控回填，满格后怎么按都删不掉。
      if (next[start] !== "") {
        next[start] = "";
        setDigits(next);
      }
      return;
    }
    let pos = start;
    for (const ch of chars) {
      if (pos >= CODE_LENGTH) break;
      next[pos] = ch;
      pos += 1;
    }
    setDigits(next);
    digitRefs.current[Math.min(pos, CODE_LENGTH - 1)]?.focus();
  }

  function resetCode() {
    setDigits(Array(CODE_LENGTH).fill(""));
    digitRefs.current[0]?.focus();
  }

  async function authorizeRelay() {
    if (code.length !== CODE_LENGTH) {
      setPairingError("Enter the full 8-character code");
      return;
    }
    setPairingBusy(true);
    setPairingError(null);
    try {
      const res = await apiFetch("/api/admin/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "authorize", code }),
      });
      const body = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !body.success) {
        setPairingError(body.error ?? "Failed to authorize this code");
        return;
      }
      setNotice("Device authorized — the relay will pick up its token on the next poll");
      resetCode();
      await load({ silent: true });
    } catch {
      setPairingError("Failed to authorize this code");
    } finally {
      setPairingBusy(false);
    }
  }

  async function rename(id: number, name: string) {
    const res = await apiFetch(`/api/admin/devices/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Rename failed");
      return;
    }
    setRenameId(null);
    await load();
  }

  async function setRevoked(device: DeviceItem, revoked: boolean) {
    const ok = await confirm({
      title: revoked ? "Revoke this device?" : "Re-enable this device?",
      message: revoked ? (
        <ul className="list-disc pl-5 text-sm text-gray-700">
          <li>Plan and report requests from this relay start failing with 401 immediately.</li>
          <li>Already issued key leases stay valid until their 60s TTL expires.</li>
          <li>Its token is kept, so re-enabling restores the relay without re-pairing.</li>
        </ul>
      ) : (
        <p className="text-sm text-gray-700">
          The relay keeps working with its existing token. Delete the device instead if the token may
          have leaked.
        </p>
      ),
      confirmLabel: revoked ? "Revoke" : "Re-enable",
      tone: revoked ? "danger" : "primary",
    });
    if (!ok) return;
    const res = await apiFetch(`/api/admin/devices/${device.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ revoked }),
    });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Update failed");
      return;
    }
    await load();
  }

  async function remove(device: DeviceItem) {
    const ok = await confirm({
      title: "Delete this device?",
      message: (
        <ul className="list-disc pl-5 text-sm text-gray-700">
          <li>Plan and report requests from this relay start failing with 401 immediately.</li>
          <li>Its unfinished plan rows are removed.</li>
          <li>Usage records are <strong>kept</strong> — only the device attribution is cleared.</li>
        </ul>
      ),
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    const res = await apiFetch(`/api/admin/devices/${device.id}`, { method: "DELETE" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? "Delete failed");
      return;
    }
    await load();
  }

  return (
    <div className="space-y-4">
      {confirmDialog}

      <AdminTableCard title={<h2 className="text-base font-semibold text-gray-900">Relay devices</h2>}>
        <p className="text-sm text-gray-500">
          A relay forwards request bodies straight to the upstream and only asks the center for a plan
          and reports the outcome. Pairing codes are generated by the center.
        </p>
        {error && <p className="mt-3 text-sm text-red-600">{error}</p>}
        {notice && <p className="mt-3 break-all text-sm text-green-700">{notice}</p>}
        {stats && (
          <dl className="mt-4 grid grid-cols-2 gap-3 text-sm md:grid-cols-5">
            <div>
              <dt className="text-xs uppercase text-gray-500">Devices</dt>
              <dd className="text-gray-900">
                {stats.activeDevices} active / {stats.devices} total
              </dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-500">Pending pairings</dt>
              <dd className="text-gray-900">{stats.pendingPairings}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-500">Plans / min</dt>
              <dd className="text-gray-900">{stats.plansLastMinute}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-500">Reports / min</dt>
              <dd className="text-gray-900">{stats.reportsLastMinute}</dd>
            </div>
            <div>
              <dt className="text-xs uppercase text-gray-500">Relay gaps</dt>
              <dd className="text-gray-900">{stats.relayGapCount}</dd>
            </div>
          </dl>
        )}
      </AdminTableCard>

      <AdminTableCard title={<h2 className="text-base font-semibold text-gray-900">Pair a new relay</h2>}>
        <p className="text-sm text-gray-500">
          Read the pairing code from the relay logs (<code>docker logs</code>) or its <code>/pair</code>{" "}
          page. The code expires in 10 minutes.
        </p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void authorizeRelay();
          }}
          className="mt-4 flex flex-wrap items-center gap-2"
        >
          <label htmlFor="pairing-code-0" className="sr-only">
            Pairing code
          </label>
          {digits.map((digit, index) => (
            <Fragment key={index}>
              {index === 4 && <span className="px-0.5 text-gray-400">-</span>}
              <input
                id={index === 0 ? "pairing-code-0" : undefined}
                ref={(el) => {
                  digitRefs.current[index] = el;
                }}
                value={digit}
                onChange={(e) => applyChars(index, e.target.value)}
                onPaste={(e) => {
                  e.preventDefault();
                  applyChars(index, e.clipboardData.getData("text"));
                }}
                onKeyDown={(e) => {
                  if (e.key === "Backspace" && digit === "" && index > 0) {
                    e.preventDefault();
                    const next = [...digits];
                    next[index - 1] = "";
                    setDigits(next);
                    digitRefs.current[index - 1]?.focus();
                  }
                }}
                onFocus={(e) => e.target.select()}
                autoComplete="off"
                autoCapitalize="characters"
                spellCheck={false}
                inputMode="text"
                maxLength={1}
                // h-10 与右侧按钮等高（触摸区 ≥40px）；手机上按钮换行独占一行
                className="h-10 w-8 rounded border border-gray-300 text-center font-mono text-lg uppercase focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 sm:w-9"
              />
            </Fragment>
          ))}
          <button
            type="submit"
            disabled={pairingBusy || code.length !== CODE_LENGTH}
            className={`${pillAction.primary} h-10 w-full px-4 sm:ml-1 sm:w-auto`}
          >
            {pairingBusy ? "Authorizing…" : "Authorize"}
          </button>
        </form>
        {pairingError && <p className="mt-3 text-sm text-red-600">{pairingError}</p>}
      </AdminTableCard>

      <AdminTableCard
        title={<h2 className="text-base font-semibold text-gray-900">Authorized devices</h2>}
        flush
      >
        {loading ? (
          <p className="px-6 py-8 text-center text-sm text-gray-400">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-gray-400">
            No relay device yet — pair one with the code above.
          </p>
        ) : (
          <>
            <AdminTable>
              <AdminTableHead
                columns={[
                  { label: "Name" },
                  { label: "Fingerprint" },
                  { label: "Created" },
                  { label: "Last seen" },
                  { label: "RTT (5h)", align: "right" },
                  { label: "Status" },
                  { label: "Records (30d)", align: "right" },
                  { label: "Actions", align: "right" },
                ]}
              />
              <AdminTableBody>
                {devices.map((device) => (
                  <tr key={device.id}>
                    <AdminTd>
                      {renameId === device.id ? (
                        <span className="flex items-center gap-2">
                          <input
                            value={renameValue}
                            onChange={(e) => setRenameValue(e.target.value)}
                            className="w-40 rounded border border-gray-300 px-2 py-1 text-sm"
                          />
                          <button
                            type="button"
                            className={linkAction.primary}
                            onClick={() => void rename(device.id, renameValue)}
                          >
                            Save
                          </button>
                          <button
                            type="button"
                            className={linkAction.neutral}
                            onClick={() => setRenameId(null)}
                          >
                            Cancel
                          </button>
                        </span>
                      ) : (
                        <span className="text-gray-900">{device.name ?? "—"}</span>
                      )}
                    </AdminTd>
                    <AdminTd mono title={device.fingerprint}>
                      {shortFingerprint(device.fingerprint)}
                    </AdminTd>
                    <AdminTd>{formatDate(device.createdAt)}</AdminTd>
                    <AdminTd>{formatDate(device.lastSeenAt)}</AdminTd>
                    <AdminTd align="right">
                      <RttCell plan={device.latency.plan} report={device.latency.report} />
                    </AdminTd>
                    <AdminTd>
                      <span className={device.status === "active" ? statusChip.on : statusChip.off}>
                        {STATUS_LABEL[device.status]}
                      </span>
                    </AdminTd>
                    <AdminTd align="right">{device.recordCount30d}</AdminTd>
                    <AdminTd align="right">
                      <span className="flex flex-wrap items-center justify-end gap-3">
                        <button
                          type="button"
                          className={linkAction.primary}
                          onClick={() => {
                            setRenameId(device.id);
                            setRenameValue(device.name ?? "");
                          }}
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          className={device.revokedAt ? linkAction.primary : linkAction.warning}
                          onClick={() => void setRevoked(device, device.revokedAt === null)}
                        >
                          {device.revokedAt ? "Unrevoke" : "Revoke"}
                        </button>
                        <button
                          type="button"
                          className={linkAction.danger}
                          onClick={() => void remove(device)}
                        >
                          Delete
                        </button>
                      </span>
                    </AdminTd>
                  </tr>
                ))}
              </AdminTableBody>
            </AdminTable>

            <AdminMobileCards>
              {devices.map((device) => (
                <AdminMobileCard key={device.id}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-medium text-gray-900">
                        {device.name ?? "—"}
                      </p>
                      <p className="font-mono text-xs text-gray-500">
                        {shortFingerprint(device.fingerprint)}
                      </p>
                    </div>
                    <span className={device.status === "active" ? statusChip.on : statusChip.off}>
                      {STATUS_LABEL[device.status]}
                    </span>
                  </div>
                  <dl className="mt-3 grid grid-cols-2 gap-2 text-xs text-gray-600">
                    <div>
                      <dt className="text-gray-400">Created</dt>
                      <dd>{formatDate(device.createdAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Last seen</dt>
                      <dd>{formatDate(device.lastSeenAt)}</dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Records (30d)</dt>
                      <dd>{device.recordCount30d}</dd>
                    </div>
                    <div>
                      <dt className="text-gray-400">Latency (5h)</dt>
                      <dd className="font-mono">
                        {formatRtt(device.latency.plan.latestMs)}
                        <span className="ml-1 font-sans text-gray-400">
                          (avg {formatRtt(device.latency.plan.avgMs)} / max{" "}
                          {formatRtt(device.latency.plan.maxMs)})
                        </span>
                      </dd>
                    </div>
                  </dl>
                  {renameId === device.id ? (
                    <div className="mt-3 flex items-center gap-2">
                      <input
                        value={renameValue}
                        onChange={(e) => setRenameValue(e.target.value)}
                        className="min-w-0 flex-1 rounded border border-gray-300 px-2 py-2 text-sm"
                      />
                      <button
                        type="button"
                        className={linkAction.primary}
                        onClick={() => void rename(device.id, renameValue)}
                      >
                        Save
                      </button>
                      <button
                        type="button"
                        className={linkAction.neutral}
                        onClick={() => setRenameId(null)}
                      >
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <div className="mt-3 flex flex-wrap gap-3">
                      <button
                        type="button"
                        className={tapAction.primary}
                        onClick={() => {
                          setRenameId(device.id);
                          setRenameValue(device.name ?? "");
                        }}
                      >
                        Rename
                      </button>
                      <button
                        type="button"
                        className={device.revokedAt ? tapAction.primary : tapAction.warning}
                        onClick={() => void setRevoked(device, device.revokedAt === null)}
                      >
                        {device.revokedAt ? "Unrevoke" : "Revoke"}
                      </button>
                      <button
                        type="button"
                        className={tapAction.danger}
                        onClick={() => void remove(device)}
                      >
                        Delete
                      </button>
                    </div>
                  )}
                </AdminMobileCard>
              ))}
            </AdminMobileCards>
          </>
        )}
      </AdminTableCard>
    </div>
  );
}
