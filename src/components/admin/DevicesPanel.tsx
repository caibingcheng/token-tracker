"use client";

// Admin Devices tab：relay（sub node）设备管理。
// - 配对：输码 → 看设备信息 → 授权 / 拒绝（码是中心生成的 8 位码，relay 只负责展示）
// - 列表：改名 / 撤销 / 解除撤销 / 轮换 token / 删除（删设备不删历史记录，device_id 置 NULL）
// - 统计：待授权配对数、预留泄漏计数（relay_gap_count）、plan/report 每分钟速率
// 约定：桌面 table + md:hidden 卡片双轨，触摸区 ≥40px（见 components/admin/table.tsx）。

import { useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "@/lib/client/api-client";
import { copyText } from "@/lib/clipboard";
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

interface DeviceItem {
  id: number;
  fingerprint: string;
  name: string | null;
  createdAt: string;
  lastSeenAt: string | null;
  revokedAt: string | null;
  status: "pending" | "active" | "revoked";
  recordCount30d: number;
}

interface Stats {
  pendingPairings: number;
  relayGapCount: number;
  plansLastMinute: number;
  reportsLastMinute: number;
  devices: number;
  activeDevices: number;
}

interface PairingLookup {
  name: string | null;
  fingerprint: string;
  clientIp: string | null;
  createdAt: string;
  expiresAt: number;
  /** 仅 /pairings 列表返回：= code_hash，用于列表里一键授权（免手输码） */
  pairingId?: string;
}

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

// 剩余时间 m:ss（用本地时钟；expiresAt 是中心侧的 epoch ms）
function remainingLabel(expiresAt: number, now: number): string {
  const seconds = Math.max(0, Math.round((expiresAt - now) / 1000));
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds % 60).padStart(2, "0")}`;
}

const STATUS_LABEL: Record<DeviceItem["status"], string> = {
  pending: "pending",
  active: "active",
  revoked: "revoked",
};

export default function DevicesPanel() {
  const [devices, setDevices] = useState<DeviceItem[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [pending, setPending] = useState<PairingLookup[]>([]);
  // 轮询退避：待授权列表拿不到（如路由未注册 404/405、服务重启中）时不要每 3s 刷屏 Console
  const pollFailedRef = useRef(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  // 待授权列表自己的加载错误（例如 API 未重启导致 404）：不静默吞咽，否则页面只会
  // 一直显示「No pending」，让人以为配对没发出来
  const [pendingError, setPendingError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // 倒计时基准时钟（仅在有 pending 时每秒走，避免无意义重渲染）
  const [now, setNow] = useState(() => Date.now());

  // 配对表单
  const [code, setCode] = useState("");
  const [pairing, setPairing] = useState<PairingLookup | null>(null);
  const [pairingBusy, setPairingBusy] = useState(false);
  const [pairingError, setPairingError] = useState<string | null>(null);

  // 行内改名
  const [renameId, setRenameId] = useState<number | null>(null);
  const [renameValue, setRenameValue] = useState("");

  const [confirm, confirmDialog] = useConfirm();

  const load = useCallback(async (opts?: { silent?: boolean }) => {
    if (!opts?.silent) setLoading(true);
    try {
      const [listRes, statsRes, pendingRes] = await Promise.all([
        apiFetch("/api/admin/devices"),
        apiFetch("/api/admin/devices/stats"),
        apiFetch("/api/admin/devices/pairings"),
      ]);
      const listBody = (await listRes.json()) as { success?: boolean; data?: DeviceItem[]; error?: string };
      const statsBody = (await statsRes.json()) as { success?: boolean; data?: Stats };
      const pendingBody = (await pendingRes.json().catch(() => ({}))) as {
        success?: boolean;
        data?: PairingLookup[];
      };
      if (!listRes.ok || !listBody.success) {
        setError(listBody.error ?? "Failed to load devices");
      } else {
        setDevices(listBody.data ?? []);
        setError(null);
      }
      if (statsRes.ok && statsBody.success) setStats(statsBody.data ?? null);
      if (pendingRes.ok && pendingBody.success) {
        setPending(pendingBody.data ?? []);
        setPendingError(null);
        pollFailedRef.current = false;
      } else {
        pollFailedRef.current = true;
        setPendingError(
          pendingRes.status === 404 || pendingRes.status === 405
            ? `failed to load pending requests (HTTP ${pendingRes.status}) — restart the center so the new routes register`
            : `failed to load pending requests (HTTP ${pendingRes.status})`
        );
      }
    } catch {
      setError("Failed to load devices");
    } finally {
      if (!opts?.silent) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 自动刷新：relay 一发起配对就会出现待授权请求，配对成功（poll 拿到 token）后设备状态
  // 自动从 pending 变 active。页面不可见时跳过；失败时退避到 15s（不刷屏）。
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
      }, pollFailedRef.current ? 15_000 : 3_000);
    };
    schedule();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    if (pending.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [pending.length]);

  async function lookup() {
    setPairingError(null);
    setPairing(null);
    const trimmed = code.trim();
    if (trimmed === "") {
      setPairingError("Enter the 8-character code shown by the relay");
      return;
    }
    setPairingBusy(true);
    try {
      const res = await apiFetch("/api/device/pair/lookup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: trimmed }),
      });
      const body = (await res.json()) as { success?: boolean; data?: PairingLookup; error?: string };
      if (!res.ok || !body.success) {
        setPairingError(body.error ?? "Unknown or expired code");
        return;
      }
      setPairing(body.data ?? null);
    } catch {
      setPairingError("Lookup failed");
    } finally {
      setPairingBusy(false);
    }
  }

  async function decidePairing(
    action: "authorize" | "deny",
    target?: { pairingId?: string; code?: string }
  ) {
    setPairingBusy(true);
    setPairingError(null);
    try {
      const payload = target?.pairingId
        ? { action, pairingId: target.pairingId }
        : { action, code: (target?.code ?? code).trim() };
      const res = await apiFetch("/api/admin/devices", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const body = (await res.json()) as { success?: boolean; error?: string };
      if (!res.ok || !body.success) {
        setPairingError(body.error ?? "Failed to update pairing");
        return;
      }
      setNotice(
        action === "authorize"
          ? "Device authorized — the relay will pick up its token on the next poll"
          : "Pairing request denied"
      );
      setPairing(null);
      setCode("");
      await load({ silent: true });
    } catch {
      setPairingError("Failed to update pairing");
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
          <li>「{device.name ?? shortFingerprint(device.fingerprint)}」的 plan / report 立即 401</li>
          <li>已下发的 key lease 仍可用到 60s TTL 结束（撤销不等于立即断开在途请求）</li>
          <li>历史记录保留，device 归属不变</li>
        </ul>
      ) : (
        <p className="text-sm text-gray-700">
          恢复后该设备可用现有 token 继续请求；若 token 已泄露，请先轮换 token。
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

  async function rotate(device: DeviceItem) {
    const ok = await confirm({
      title: "Rotate device token?",
      message: (
        <p className="text-sm text-gray-700">
          旧 token 立即失效，relay 需要重新配对（或手动更新 <code>relay.state.json</code>）。新 token
          只显示一次。
        </p>
      ),
      confirmLabel: "Rotate",
      tone: "warning",
    });
    if (!ok) return;
    const res = await apiFetch(`/api/admin/devices/${device.id}/rotate-token`, { method: "POST" });
    const body = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      data?: { token: string };
      error?: string;
    };
    if (!res.ok || !body.success || !body.data) {
      setError(body.error ?? "Rotate failed");
      return;
    }
    setNotice(`New token for ${device.name ?? shortFingerprint(device.fingerprint)}: ${body.data.token}`);
    await load();
  }

  async function remove(device: DeviceItem) {
    const ok = await confirm({
      title: "Delete this device?",
      message: (
        <ul className="list-disc pl-5 text-sm text-gray-700">
          <li>删除后该设备的 plan / report 立即 401</li>
          <li>未完成的 plan 行一并清除</li>
          <li>已写入的 token_records <strong>保留</strong>，仅把 device 归属置空</li>
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
          Relay（sub node）把请求体直接打给上游，只向中心要执行计划与回报结果。码由中心生成：在
          relay 的 <code>docker logs</code> 或 <code>/pair</code> 页面读出 8 位码后在此授权。
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

      <AdminTableCard
        title={
          <h2 className="text-base font-semibold text-gray-900">
            Pending pairing requests{pending.length > 0 ? ` (${pending.length})` : ""}
          </h2>
        }
        actions={<span className="text-xs text-gray-400">auto-refresh every 3s</span>}
      >
        <p className="text-sm text-gray-500">
          A relay shows up here right after it starts (its code is also printed in{" "}
          <code>docker logs</code> or on its <code>/pair</code> page). Authorize here, or enter the code
          below if the relay is on another network.
        </p>
        {pendingError && <p className="mt-3 text-sm text-red-600">{pendingError}</p>}
        {pending.length === 0 ? (
          <p className="mt-3 text-sm text-gray-400">
            No pending pairing requests — start the relay (or <code>npm run dev:relay</code>) and it will
            show up here within a few seconds.
          </p>
        ) : (
          <div className="mt-3 space-y-2">
            {pending.map((p) => (
              <div
                key={p.pairingId ?? `${p.fingerprint}-${p.createdAt}`}
                className="flex flex-col gap-2 rounded border border-gray-200 bg-gray-50 p-3 md:flex-row md:items-center md:justify-between"
              >
                <div className="grid min-w-0 flex-1 grid-cols-1 gap-x-4 gap-y-1 text-sm md:grid-cols-4">
                  <div className="min-w-0">
                    <p className="text-xs uppercase text-gray-500">Name</p>
                    <p className="truncate text-gray-900">{p.name ?? "—"}</p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs uppercase text-gray-500">Fingerprint</p>
                    <p className="truncate font-mono text-xs text-gray-900" title={p.fingerprint}>
                      {shortFingerprint(p.fingerprint)}
                    </p>
                  </div>
                  <div className="min-w-0">
                    <p className="text-xs uppercase text-gray-500">IP</p>
                    <p className="truncate font-mono text-xs text-gray-900">{p.clientIp ?? "—"}</p>
                  </div>
                  <div>
                    <p className="text-xs uppercase text-gray-500">Expires in</p>
                    <p className="tabular-nums text-gray-900">{remainingLabel(p.expiresAt, now)}</p>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={() => void decidePairing("authorize", { pairingId: p.pairingId })}
                    disabled={pairingBusy || !p.pairingId}
                    className={pillAction.primary}
                  >
                    Authorize
                  </button>
                  <button
                    type="button"
                    onClick={() => void decidePairing("deny", { pairingId: p.pairingId })}
                    disabled={pairingBusy || !p.pairingId}
                    className={pillAction.danger}
                  >
                    Deny
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </AdminTableCard>

      <AdminTableCard title={<h2 className="text-base font-semibold text-gray-900">Pair a new relay</h2>}>
        <div className="flex flex-col gap-3 md:flex-row md:items-end">
          <label className="flex-1 text-sm text-gray-700">
            Pairing code
            <input
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder="ABCD-EFGH"
              autoComplete="off"
              spellCheck={false}
              className="mt-1 w-full rounded border border-gray-300 px-3 py-2 font-mono text-sm uppercase tracking-widest"
            />
          </label>
          <div className="flex gap-2">
            <button
              type="button"
              onClick={() => void lookup()}
              disabled={pairingBusy}
              className={pillAction.primary}
            >
              Look up
            </button>
          </div>
        </div>
        {pairingError && <p className="mt-3 text-sm text-red-600">{pairingError}</p>}
        {pairing && (
          <div className="mt-4 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
            <dl className="grid grid-cols-1 gap-2 md:grid-cols-4">
              <div>
                <dt className="text-xs uppercase text-gray-500">Name</dt>
                <dd className="text-gray-900">{pairing.name ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-gray-500">Fingerprint</dt>
                <dd className="font-mono text-xs text-gray-900">{pairing.fingerprint}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-gray-500">Request IP</dt>
                <dd className="font-mono text-xs text-gray-900">{pairing.clientIp ?? "—"}</dd>
              </div>
              <div>
                <dt className="text-xs uppercase text-gray-500">Expires</dt>
                <dd className="text-gray-900">{formatDate(new Date(pairing.expiresAt).toISOString())}</dd>
              </div>
            </dl>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                onClick={() => void decidePairing("authorize")}
                disabled={pairingBusy}
                className={pillAction.primary}
              >
                Authorize
              </button>
              <button
                type="button"
                onClick={() => void decidePairing("deny")}
                disabled={pairingBusy}
                className={pillAction.danger}
              >
                Deny
              </button>
            </div>
          </div>
        )}
      </AdminTableCard>

      <AdminTableCard
        title={<h2 className="text-base font-semibold text-gray-900">Authorized devices</h2>}
        flush
      >
        {loading ? (
          <p className="px-6 py-8 text-center text-sm text-gray-400">Loading…</p>
        ) : devices.length === 0 ? (
          <p className="px-6 py-8 text-center text-sm text-gray-400">
            No relay device yet — authorize a request above (or enter its code) and it will appear here
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
                          className={linkAction.neutral}
                          onClick={() => void rotate(device)}
                        >
                          Rotate token
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
                        className={tapAction.neutral}
                        onClick={() => void rotate(device)}
                      >
                        Rotate token
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
        {notice && notice.startsWith("New token") && (
          <div className="border-t border-gray-100 px-6 py-3">
            <button
              type="button"
              className={pillAction.neutral}
              onClick={() => void copyText(notice)}
            >
              Copy new token
            </button>
          </div>
        )}
      </AdminTableCard>
    </div>
  );
}
