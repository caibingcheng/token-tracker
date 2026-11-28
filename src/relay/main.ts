// relay 入口：只挂 /v1* /v1beta* /raw*（纯透传）+ /pair（内联页）。
// 不注册 /api/*（device 端点属于中心，relay 不做 sub node 互通），不引入会话验签。
//
// 构建期硬约束：本入口的 bundle 里不存在 @/lib/db / @/lib/auth / @/lib/gateway/proxy
//（见 scripts/build-server.mjs 的第二个 build()）。启动自检只是防「拉错镜像」，
// 真正的边界是 bundle 里没有那些代码。
import { serve } from "@hono/node-server";
import type { Context } from "hono";
import { Hono } from "hono";
import { prepare, RelayHttpError } from "./prepare";
import { RELAY_VERSION, requestPlan, type PlanRequest } from "./plan-client";
import { executePlan } from "./executor";
import {
  currentDeviceToken,
  devicePrivateKeyPem,
  pairPageAllowed,
  pairRuntime,
  pairView,
  recordPlanOutcome,
  recoverFromRejectedToken,
  renderPairPage,
  startPairing,
} from "./pair";
import { centerUrlHash, getCenterDeviceName, setCenterDeviceName } from "./state";
import { privateUpstreamsAllowed } from "@/lib/gateway/url-guard";

const CENTER_ONLY_ENV = ["SQLITE_DATABASE_PATH", "ADMIN_API_KEY", "LOCAL_ADMIN_BYPASS", "GATEWAY_SECRET"];
const MODEL_LIST_HEADERS = { "cache-control": "no-store", "x-accel-buffering": "no" };

function errorResponse(status: number, type: string, message: string): Response {
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
}

// 防误拉错镜像：relay 进程里出现中心专用 env 直接拒绝启动（不是安全边界）
function assertRelayEnv(): void {
  const leaked = CENTER_ONLY_ENV.filter((name) => {
    const value = process.env[name];
    return value !== undefined && value !== "";
  });
  if (leaked.length > 0) {
    console.error(
      `[relay] refusing to start: this image is for the center (found ${leaked.join(", ")}). ` +
        "Use the token-tracker-relay image instead."
    );
    process.exit(1);
  }
  const centerUrl = process.env.CENTER_URL?.trim();
  if (!centerUrl) {
    console.error("[relay] refusing to start: CENTER_URL is required");
    process.exit(1);
  }
  let parsed: URL;
  try {
    parsed = new URL(centerUrl);
  } catch {
    console.error("[relay] refusing to start: CENTER_URL is not a valid URL");
    process.exit(1);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    console.error("[relay] refusing to start: CENTER_URL must start with http(s)://");
    process.exit(1);
  }
  const loopback =
    parsed.hostname === "localhost" ||
    parsed.hostname === "::1" ||
    parsed.hostname.startsWith("127.");
  // 明文 http 只在环回/内网部署下允许（device token 与 lease 都走这条链路）
  if (parsed.protocol === "http:" && !loopback && !privateUpstreamsAllowed()) {
    console.error(
      "[relay] refusing to start: CENTER_URL must use https for non-loopback hosts " +
        "(set ALLOW_PRIVATE_UPSTREAMS=true only for trusted private networks)"
    );
    process.exit(1);
  }
}

assertRelayEnv();

// /pair 页的访问控制要拿对端地址（默认只允许环回/私网来源）
function remoteAddress(c: Context): string | null {
  return (
    (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)?.incoming?.socket
      ?.remoteAddress ?? null
  );
}

const app = new Hono({ strict: false });

// /pair 页的安全响应头：relay 是独立 Hono 实例，不走中心 src/server/security-headers.ts。
// 页面含内联 <script>（自动刷新）与内联 <style>（卡片样式），两者都需要 'unsafe-inline' ——
// 少了 style-src 时 style-src 回落到 default-src 'self'，内联样式被拒，页面退化成裸文字。
// frame-ancestors 'none' + XFO 防 clickjacking（默认只放行环回/私网来源，但同一内网的
// 其他网页仍可把它包成 iframe 骗管理员输码）。
const PAIR_PAGE_HEADERS = {
  "x-frame-options": "DENY",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "content-security-policy":
    "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; frame-ancestors 'none'; base-uri 'self'; form-action 'none'",
};

app.get("/pair", (c) => {
  if (!pairPageAllowed(remoteAddress(c))) {
    return new Response(
      "pair page is local-only (set RELAY_PAIR_PAGE=on to expose it); the code is printed in `docker logs`\n",
      {
        status: 403,
        headers: { ...PAIR_PAGE_HEADERS, "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
      }
    );
  }
  return new Response(renderPairPage(), {
    headers: { ...PAIR_PAGE_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
});

// /pair 页的自动刷新数据源：同一份 pairView()，页面只在派生值变化时整页重渲染
app.get("/pair/status", (c) => {
  if (!pairPageAllowed(remoteAddress(c))) {
    return c.json({ error: "pair page is local-only" }, 403, { ...PAIR_PAGE_HEADERS, "cache-control": "no-store" });
  }
  return c.json(pairView(), 200, { ...PAIR_PAGE_HEADERS, "cache-control": "no-store" });
});

let policyChecked = false;
let revokedLogged = false;

async function handleProxy(c: Context): Promise<Response> {
  const deviceToken = currentDeviceToken();
  if (!deviceToken) {
    return errorResponse(503, "relay_not_paired", "Relay is not paired with the center yet");
  }
  const url = new URL(c.req.url);
  let prepared;
  try {
    prepared = await prepare(c.req.raw, url);
  } catch (err) {
    if (err instanceof RelayHttpError) return errorResponse(err.status, err.type, err.message);
    throw err;
  }
  if (!prepared.vkFp) {
    return errorResponse(401, "authentication_error", "Missing virtual key");
  }

  const pathname = url.pathname;
  const responseId = pathname.startsWith("/v1/responses/")
    ? pathname.slice("/v1/responses/".length).split("/")[0] || null
    : null;
  const planRequest: PlanRequest = {
    vkFp: prepared.vkFp,
    path: prepared.path,
    model: prepared.model,
    protocol: prepared.protocol,
    stream: prepared.stream,
    nativeSessionId: prepared.nativeSessionId,
    sessionInput: prepared.sessionInput,
    hasMessages: prepared.hasMessages,
    responseId,
    userAgent: c.req.header("user-agent")?.slice(0, 512) ?? null,
    estimatedInputTokens: prepared.estimatedInputTokens,
    headerNames: prepared.headerNames,
  };

  let planned;
  try {
    planned = await requestPlan(deviceToken, planRequest);
  } catch (err) {
    console.error(`[relay] plan request failed: ${err instanceof Error ? err.message : String(err)}`);
    recordPlanOutcome("center unreachable");
    return errorResponse(502, "center_unreachable", "Center is unreachable from this relay");
  }
  if (!planned.ok) {
    if (planned.deviceRevoked) {
      // 被 admin 撤销 ≠ token 无效：保留 token，中心 unrevoke 后下一次请求就自动恢复。
      // （以前一律清 token + 重新配对，导致 unrevoke 后 relay 已把凭证丢掉，永远连不上）
      if (!revokedLogged) {
        revokedLogged = true;
        console.warn(
          "[relay] this device is revoked on the center — keeping the token; unrevoke it under Admin → Devices to recover"
        );
      }
      recordPlanOutcome("revoked");
      return errorResponse(
        503,
        "relay_revoked",
        "This relay device was revoked on the center; unrevoke it in Admin → Devices"
      );
    }
    recordPlanOutcome(`${planned.status} ${planned.error.error.type}`);
    if (planned.deviceTokenRejected) {
      // 自愈：清楚旧 token 并重新配对（同一 fingerprint 会被中心当作 reauth，历史记录不断链）
      void recoverFromRejectedToken(planned.error.error.message);
      return errorResponse(
        503,
        "relay_unpaired",
        "This relay is no longer authorized by the center; it is pairing again — check /pair on the relay"
      );
    }
    if (planned.status === 401) {
      console.error(
        "[relay] center rejected this device token (revoked or deleted) — re-pair this relay from /admin/devices"
      );
    }
    return errorResponse(planned.status, planned.error.error.type, planned.error.error.message);
  }

  const plan = planned.plan;
  // 恢复后重置：下次再被撤销时还能打一行提示
  revokedLogged = false;
  // 中心改名（PATCH /admin/devices/:id）后无需心跳：下一次 plan 就带回来，/pair 页跟着变。
  // 只在变化时打一行日志，避免每个请求都刷屏。
  if (plan.device && plan.device.name !== null && plan.device.name !== getCenterDeviceName()) {
    console.log(`[relay] center device name: "${plan.device.name}"`);
    setCenterDeviceName(plan.device.name);
  }
  if (!policyChecked) {
    policyChecked = true;
    const localMb = Math.max(1, Math.round(Number(process.env.GATEWAY_MAX_BODY_MB ?? 32)));
    const centerMb = plan.policy.centerMaxBodyMb;
    if (localMb < centerMb) {
      console.warn(
        `[relay] warn: local maxBodyMb=${localMb} < center=${centerMb}; some requests accepted by the center will be rejected here`
      );
    } else if (localMb > centerMb) {
      console.log(
        `[relay] info: local maxBodyMb=${localMb} > center=${centerMb}; bodies ${centerMb}-${localMb}MB are accepted only via this relay`
      );
    }
  }

  // models 模式：快照来自中心（非通配 enabled_models ∪ enabled 命名路由名，已按 vk allowlist 过滤）
  if (plan.modelsSnapshot !== null) {
    const models = plan.modelsSnapshot;
    recordPlanOutcome("ok (models)");
    return new Response(
      JSON.stringify({
        object: "list",
        data: models.map((id) => ({ id, object: "model", created: 0, owned_by: "gateway" })),
      }),
      { headers: { ...MODEL_LIST_HEADERS, "content-type": "application/json" } }
    );
  }

  return executePlan({
    plan,
    deviceToken,
    devicePrivateKeyPem: devicePrivateKeyPem(),
    prepared,
    request: c.req.raw,
    streamIdleTimeoutMs: plan.policy.streamIdleTimeoutMinutes * 60_000,
    onOutcome: recordPlanOutcome,
  });
}

app.all("/v1/*", handleProxy);
app.all("/v1beta/*", handleProxy);
app.all("/raw/*", handleProxy);

app.notFound((c) =>
  c.req.path === "/"
    ? c.text(`token-tracker relay ${RELAY_VERSION}\n`, 200)
    : errorResponse(404, "not_found", "Not found")
);

const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOSTNAME || "0.0.0.0";

const rt = pairRuntime();
if (
  rt.state.centerUrlHash &&
  rt.state.centerUrlHash !== centerUrlHash(process.env.CENTER_URL ?? "")
) {
  console.warn(
    "[relay] CENTER_URL changed since pairing — re-pair this relay if plan requests fail"
  );
}
if (rt.state.deviceToken) {
  console.log(`[relay] paired${rt.state.pairedAt ? ` at ${rt.state.pairedAt}` : ""}; waiting for requests`);
} else {
  void startPairing();
}

const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`[relay] listening on http://${hostname}:${info.port}`);
});

let closing = false;
function shutdown() {
  if (closing) return;
  closing = true;
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
