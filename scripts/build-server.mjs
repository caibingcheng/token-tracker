#!/usr/bin/env node
// 服务端 bundle（两个 entry，同一次构建）：
// - src/server/index.ts → build/server.js（中心：页面 + API + 代理，external 仅 better-sqlite3）
// - src/relay/main.ts  → build/relay.js（relay：只有 /v1* /v1beta* /raw* + /pair，零 DB/认证代码）
//
// 路径别名（@/*、next/server → shim）全部走 tsconfig.json paths —— esbuild 原生读取 tsconfig，
// 不在这里维护第二份别名配置（vitest 在 vitest.config.mts 单独声明，因为 Vite 不读 tsconfig paths）。
//
// relay 的「不碰 DB / 认证 / proxy」是**构建期硬约束**：下面的 plugin 在解析到中心专用模块时直接
// 让构建失败。比 code review 和静态扫描都硬 —— build/relay.js 里根本不存在那些模块。
import { build } from "esbuild";

const CENTER_ONLY = [
  /^@\/lib\/db(?:\/|$)/,
  /^@\/lib\/auth(?:\/|$)/,
  /^@\/lib\/admin(?:\/|$)/,
  /^@\/lib\/device(?:\/|$)/,
  /^@\/lib\/ingest(?:\/|$)/,
  /^@\/lib\/sync(?:\/|$)/,
  /^@\/routes(?:\/|$)/,
  /^@\/lib\/gateway\/proxy$/,
  /^@\/lib\/gateway\/proxy-deps$/,
  /^@\/lib\/gateway\/plan$/,
  /^@\/lib\/gateway\/health$/,
  /^@\/lib\/gateway\/quota(?:-db|-inflight)?$/,
  /^better-sqlite3$/,
  /^drizzle-orm(?:\/|$)/,
];

const relayGuard = {
  name: "relay-guard",
  setup(buildApi) {
    buildApi.onResolve({ filter: /.*/ }, (args) => {
      for (const pattern of CENTER_ONLY) {
        if (pattern.test(args.path)) {
          return {
            errors: [
              {
                text: `relay bundle must not import center-only module "${args.path}" (from ${args.importer})`,
              },
            ],
          };
        }
      }
      return null;
    });
  },
};

await build({
  entryPoints: ["src/server/index.ts"],
  outfile: "build/server.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // native prebuild，必须运行时从 node_modules 解析；Docker runner 只拷这一个包
  //（其 require 面 = fs/path + prebuilds + 自身文件，零外部依赖）
  external: ["better-sqlite3"],
  logLevel: "info",
});

await build({
  entryPoints: ["src/relay/main.ts"],
  outfile: "build/relay.js",
  bundle: true,
  platform: "node",
  target: "node22",
  format: "cjs",
  // 无 native 依赖：镜像里不需要 node_modules
  plugins: [relayGuard],
  logLevel: "info",
});
