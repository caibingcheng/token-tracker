#!/usr/bin/env node
// relay 的本地开发入口（等价于中心的 `npm run dev`）：`npm run dev:relay`。
//
// 与生产镜像的差别只有「怎么启动」：这里用 tsx watch 直接跑 TS（改代码/改它 import 的
// gateway 模块都会自动重启），不产出 build/relay.js。构建期硬约束（relay 不得 import
// DB/auth/proxy）仍由 `npm run build` 的 esbuild plugin 把关，本脚本不重复实现。
//
// 为什么需要这个脚本而不是一行 `tsx watch src/relay/main.ts`：
// 1. 默认 env（CENTER_URL 指向 dev 中心的 Hono 端口、PORT 3010、state 落 data/）——否则每次
//    都要手敲四个变量；
// 2. **剥离中心专用 env**：镜像里的启动自检遇到 SQLITE_DATABASE_PATH / GATEWAY_SECRET /
//    ADMIN_API_KEY / LOCAL_ADMIN_BYPASS 会直接 exit 1（防误拉错镜像）。开发时这些变量常常
//    已经在同一个 shell 里 export 了（或从 .env 里抄过来），不剥离就会「本地永远起不来」。
//    注意：这是开发脚本的便利，**不是**放宽镜像自检——生产镜像仍然 fail-closed。
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

const CENTER_ONLY = ["SQLITE_DATABASE_PATH", "ADMIN_API_KEY", "GATEWAY_SECRET", "LOCAL_ADMIN_BYPASS"];

const apiPort = process.env.DEV_API_PORT || "3001";
const defaults = {
  // dev 中心的 /api 在 :3001（Hono 直连，loopback 明文由 sync scope 放行）；
  // 走 :3000 会多一跳 next rewrite，没必要
  CENTER_URL: `http://127.0.0.1:${apiPort}`,
  PORT: "3010",
  HOSTNAME: "127.0.0.1", // dev 不对外暴露 /pair 与代理入口
  RELAY_STATE_PATH: join(process.cwd(), "data", "relay.state.json"),
  RELAY_DEVICE_NAME: "dev-relay",
  // dev 上游基本都是私网/环回（fake upstream :4010、本机 ollama、局域网 vLLM）：lease 里带
  // requiresPrivateNetwork 时 relay 本地不放开就只会得到 502 upstream_error（中心侧早已
  // 用同一个开关放行，容易只漏这一头）。只想验证 fail-closed 行为时显式传
  // ALLOW_PRIVATE_UPSTREAMS=false npm run dev:relay。生产镜像不受影响（仍 fail-closed）
  ALLOW_PRIVATE_UPSTREAMS: "true",
};

const env = { ...process.env };
const applied = [];
for (const [name, value] of Object.entries(defaults)) {
  if (env[name] === undefined || env[name] === "") {
    env[name] = value;
    applied.push(`${name}=${value}`);
  }
}
const stripped = CENTER_ONLY.filter((name) => env[name] !== undefined && env[name] !== "");
for (const name of CENTER_ONLY) delete env[name];

const tsxCli = join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
if (!existsSync(tsxCli)) {
  console.error("[dev:relay] tsx is not installed — run `npm install` first");
  process.exit(1);
}

console.log("[dev:relay] relay (tsx watch) — Ctrl+C to stop, Enter to force restart");
if (applied.length > 0) console.log(`[dev:relay] defaults: ${applied.join("  ")}`);
if (stripped.length > 0) {
  console.log(`[dev:relay] stripped center-only env for this process: ${stripped.join(", ")}`);
}
console.log(`[dev:relay] 1) start the center first: npm run dev   (API on :${apiPort})`);
console.log("[dev:relay] 2) authorize the printed pair code at http://localhost:3000/admin/devices");
console.log(`[dev:relay] 3) point a client at http://localhost:${env.PORT} (vk unchanged)`);
console.log(`[dev:relay] ALLOW_PRIVATE_UPSTREAMS=${env.ALLOW_PRIVATE_UPSTREAMS ?? "(unset)"} — 私网/环回上游需要 true`);

const child = spawn(process.execPath, [tsxCli, "watch", "src/relay/main.ts"], {
  stdio: "inherit",
  env,
});

const stop = (signal) => {
  if (!child.killed) child.kill(signal);
};
process.on("SIGINT", () => stop("SIGINT"));
process.on("SIGTERM", () => stop("SIGTERM"));
child.on("exit", (code) => process.exit(code ?? 0));
