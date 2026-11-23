#!/usr/bin/env node
// 双进程 dev 编排（换 Hono 后 next dev 只负责页面）：
//   :3000  next dev —— 页面 HMR；next.config.js dev 分支把 /api、/v1*、/raw、/ingest rewrites 到 :3001
//   :3001  Hono API —— tsx watch 热重启（src/server、src/routes、src/lib 变更即重启）
// 同源转发，无 CORS。主密钥先在这里 ensure 并注入 env，两个子进程继承同一把。
// 新增/移动/编辑 src/routes 下的 route 无需重启本脚本（fs.watch 自动重跑 gen-routes）。
import { spawn, spawnSync } from "node:child_process";
import { watch } from "node:fs";
import { createRequire } from "node:module";
import readline from "node:readline";
import dotenv from "dotenv";

const require = createRequire(import.meta.url);
const { ensureDevGatewaySecret } = require("./dev-secret.cjs");

// 与 next dev 同口径先加载 env（纯 node 不读 .env 文件）：
// 按 Next dev 的优先级升序加载 + dotenv 不覆盖已设值 ⇒
// 最终 process.env > .env.development.local > .env.local > .env.development > .env（与 next dev 一致，两侧不分裂）。
// 不加载这一步，GATEWAY_SECRET 只存在于 .env.local 时 ensure 会误判「db 在、密钥丢」而拒绝启动
dotenv.config({ path: ".env" });
dotenv.config({ path: ".env.development" });
dotenv.config({ path: ".env.local" });
dotenv.config({ path: ".env.development.local" });

const WEB_PORT = process.env.DEV_WEB_PORT || "3000";
const API_PORT = process.env.DEV_API_PORT || "3001";

ensureDevGatewaySecret();

const gen = spawnSync(process.execPath, ["scripts/gen-routes.mjs"], { stdio: "inherit" });
if (gen.status !== 0) process.exit(gen.status ?? 1);

// src/routes 变更（含给已有 route 加方法）自动重跑 codegen：生成物被 tsx watch 看到即重启 API，
// 否则「新方法 404」会被误判成 Hono 注册 bug（200ms 防抖；新建子目录 recursive 也会命中）
let regenTimer;
watch("src/routes", { recursive: true }, () => {
  clearTimeout(regenTimer);
  regenTimer = setTimeout(() => {
    const r = spawnSync(process.execPath, ["scripts/gen-routes.mjs"], { stdio: "inherit" });
    if (r.status !== 0) console.error("[dev] gen-routes failed");
  }, 200);
});

const children = [];
let shuttingDown = false;

function prefixLines(name, stream) {
  const rl = readline.createInterface({ input: stream });
  rl.on("line", (line) => console.log(`[${name}] ${line}`));
}

function launch(name, args, extraEnv) {
  const child = spawn(process.execPath, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...extraEnv },
  });
  prefixLines(name, child.stdout);
  prefixLines(name, child.stderr);
  child.on("error", (err) => {
    console.error(`[dev] ${name} failed to start: ${err.message}`);
    process.exitCode = 1;
    shutdown();
  });
  child.on("exit", (code, signal) => {
    console.log(`[dev] ${name} exited (code=${code} signal=${signal})`);
    // 首个退出者的退出码透传给 npm（被 shutdown 杀掉的兄弟进程不覆盖）
    if (!shuttingDown) process.exitCode = code ?? 1;
    shutdown();
  });
  children.push(child);
  return child;
}

function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const child of children) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  }
  // 全部子进程退出后事件循环自然结束（readline 随管道关闭），无需主动 exit
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

launch("next", ["node_modules/next/dist/bin/next", "dev", "-p", WEB_PORT], {});
launch(
  "api",
  ["node_modules/tsx/dist/cli.mjs", "watch", "--clear-screen=false", "src/server/index.ts"],
  { PORT: API_PORT, HOSTNAME: "127.0.0.1" }
);

console.log(`[dev] web http://localhost:${WEB_PORT}  api http://127.0.0.1:${API_PORT}`);
