// relay 配对流程（RFC 8628）+ 内联 /pair 页。
// 码由中心生成，relay 只负责展示与轮询；单拿码换不到 token（码在 start 时就绑死了
// fingerprint + publicKey，poll 另需 clientSecret）。
import { isLoopbackHost, isPrivateHost } from "@/lib/gateway/url-guard";
import { getOutboundDispatcher } from "@/lib/gateway/proxy-dispatcher";
import { outboundFetch } from "@/lib/gateway/outbound-fetch";
import {
  centerUrlHash,
  displayDeviceName,
  loadState,
  saveState,
  setCenterDeviceName,
  type RelayState,
} from "./state";

export interface PairRuntime {
  state: RelayState;
  /** pending 时展示；配对成功后清空 */
  code: string | null;
  interval: number;
  status: "pairing" | "paired" | "failed";
  errorDetail: string | null;
  lastPlanOutcome: string | null;
  timer: ReturnType<typeof setTimeout> | null;
}

const runtime: PairRuntime = {
  state: loadState(process.env.CENTER_URL ?? ""),
  code: null,
  interval: 5,
  status: "pairing",
  errorDetail: null,
  lastPlanOutcome: null,
  timer: null,
};

export function pairRuntime(): PairRuntime {
  return runtime;
}

export function currentDeviceToken(): string | null {
  return runtime.state.deviceToken;
}

export function devicePrivateKeyPem(): string {
  return runtime.state.privateKeyPem;
}

function centerUrl(): string {
  return (process.env.CENTER_URL ?? "").replace(/\/+$/, "");
}

function deviceName(): string {
  // 优先级：中心（plan/poll 下发）> RELAY_DEVICE_NAME > "relay"。中心是权威展示名，
  // 本地 env 只是首次配对时报给中心的默认值。
  return displayDeviceName();
}

function clientSecret(): string {
  // clientSecret 只需在本次配对窗口内稳定；派生自私钥（不落库、不打印）
  return runtime.state.privateKeyPem.slice(-48);
}

async function postCenter(path: string, body: unknown): Promise<Response> {
  return outboundFetch(`${centerUrl()}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
    scope: "sync",
    redirect: "manual",
    dispatcher: getOutboundDispatcher(null),
    signal: AbortSignal.timeout(15_000),
  });
}

/** 首次启动 / token 失效时进入配对：打印码、按 interval 轮询，成功后落盘 */
export async function startPairing(): Promise<void> {
  if (runtime.timer) clearTimeout(runtime.timer);
  runtime.status = "pairing";
  runtime.errorDetail = null;
  try {
    const res = await postCenter("/api/device/pair/start", {
      fingerprint: runtime.state.fingerprint,
      name: deviceName(),
      publicKey: runtime.state.publicKey,
      clientSecret: clientSecret(),
    });
    const body = (await res.json().catch(() => null)) as
      | { data?: { code: string; expiresIn: number; interval: number }; error?: string }
      | null;
    if (!res.ok || !body?.data) {
      runtime.status = "failed";
      runtime.errorDetail = body?.error ?? `center returned ${res.status}`;
      console.error(`[relay] pair/start failed: ${runtime.errorDetail}`);
      return;
    }
    runtime.code = body.data.code;
    runtime.interval = body.data.interval;
    console.log(
      `[relay] pair code ${runtime.code}, expires in ${body.data.expiresIn}s — open ${centerUrl()}/admin/devices to authorize`
    );
    schedulePoll(body.data.expiresIn);
  } catch (err) {
    runtime.status = "failed";
    runtime.errorDetail = err instanceof Error ? err.message : String(err);
    console.error(`[relay] pair/start error: ${runtime.errorDetail}`);
  }
}

function schedulePoll(remainingSeconds: number): void {
  const delayMs = Math.max(1, runtime.interval) * 1000;
  runtime.timer = setTimeout(() => {
    void (async () => {
      if (remainingSeconds - runtime.interval <= 0) {
        runtime.code = null;
        runtime.status = "failed";
        runtime.errorDetail = "pairing code expired";
        console.error("[relay] pairing code expired; restart the container to get a new one");
        return;
      }
      try {
        const res = await postCenter("/api/device/pair/poll", {
          code: runtime.code,
          clientSecret: clientSecret(),
        });
        const body = (await res.json().catch(() => null)) as
          | { data?: { status: string; token: string; name: string | null }; error?: string; interval?: number }
          | null;
        if (res.status === 200 && body?.data?.token) {
          runtime.state.deviceToken = body.data.token;
          runtime.state.pairedAt = new Date().toISOString();
          runtime.state.centerUrlHash = centerUrlHash(centerUrl());
          saveState(runtime.state);
          // 中心可能已在授权时改了名：以 poll 返回为准，/pair 页和日志立即跟着变
          setCenterDeviceName(body.data.name);
          runtime.code = null;
          runtime.status = "paired";
          console.log(`[relay] paired as "${deviceName()}"`);
          return;
        }
        if (res.status === 429 && body?.error === "slow_down") {
          runtime.interval = Math.min(30, Math.max(runtime.interval * 2, body.interval ?? runtime.interval));
        } else if (res.status === 400) {
          runtime.code = null;
          runtime.status = "failed";
          runtime.errorDetail = body?.error ?? "access_denied";
          console.error(`[relay] pairing failed: ${runtime.errorDetail}`);
          return;
        }
        schedulePoll(remainingSeconds - runtime.interval);
      } catch (err) {
        runtime.errorDetail = err instanceof Error ? err.message : String(err);
        schedulePoll(remainingSeconds - runtime.interval);
      }
    })();
  }, delayMs);
  runtime.timer.unref?.();
}

export function recordPlanOutcome(label: string): void {
  runtime.lastPlanOutcome = label;
}

// ---- 内联 /pair 页（不读 out/，无构建步骤） ----

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// CENTER_URL 只展示 scheme://host（剥 userinfo / path / query）
function centerDisplay(): string {
  try {
    const url = new URL(centerUrl());
    return `${url.protocol}//${url.host}`;
  } catch {
    return "—";
  }
}

export function pairPageAllowed(remoteAddress: string | null): boolean {
  const mode = (process.env.RELAY_PAIR_PAGE ?? "local").trim();
  if (mode === "off") return false;
  if (mode === "on") return true;
  // 默认 local：只有环回/私网来源可访问
  if (!remoteAddress) return true; // 拿不到对端地址（同进程/单测）：按本机处理
  const host = remoteAddress.startsWith("[")
    ? remoteAddress.slice(1, remoteAddress.indexOf("]"))
    : remoteAddress;
  return isLoopbackHost(host) || isPrivateHost(host) || host.startsWith("::ffff:127.");
}

export function renderPairPage(): string {
  const pending = runtime.status === "pairing" && runtime.code !== null;
  const headline = pending
    ? "Waiting for authorization"
    : runtime.status === "paired"
      ? `Paired as ${escapeHtml(deviceName())}`
      : runtime.status === "failed"
        ? "Pairing failed"
        : "Pairing…";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>relay pair</title>
<style>
body{font-family:system-ui,-apple-system,sans-serif;margin:0;padding:24px;background:#f9fafb;color:#111827}
.card{max-width:520px;margin:0 auto;background:#fff;border-radius:12px;padding:20px;box-shadow:0 1px 3px rgba(0,0,0,.1)}
h1{font-size:18px;margin:0 0 12px}
.code{font-family:ui-monospace,monospace;font-size:32px;letter-spacing:.2em;margin:12px 0;padding:12px;border:1px dashed #9ca3af;border-radius:8px;text-align:center}
dl{display:grid;grid-template-columns:auto 1fr;gap:6px 12px;font-size:13px;margin:0}
dt{color:#6b7280}
dd{margin:0;font-family:ui-monospace,monospace;word-break:break-all}
p.hint{font-size:13px;color:#6b7280;margin-top:16px}
</style></head><body><div class="card">
<h1>${escapeHtml(headline)}</h1>
${pending ? `<div class="code">${escapeHtml(runtime.code ?? "")}</div>` : ""}
<dl>
<dt>Device</dt><dd>${escapeHtml(deviceName())}</dd>
<dt>Fingerprint</dt><dd>${escapeHtml(runtime.state.fingerprint.slice(0, 8))}</dd>
<dt>Center</dt><dd>${escapeHtml(centerDisplay())}</dd>
<dt>Last plan</dt><dd>${escapeHtml(runtime.lastPlanOutcome ?? "—")}</dd>
</dl>
${pending ? `<p class="hint">Enter this code on the center under <strong>Admin → Devices</strong>. The code disappears once paired.</p>` : ""}
${runtime.errorDetail ? `<p class="hint">${escapeHtml(runtime.errorDetail)}</p>` : ""}
</div></body></html>`;
}
