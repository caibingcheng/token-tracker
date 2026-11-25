#!/usr/bin/env node
// 服务端 bundle：src/server/index.ts → build/server.js（生产单文件：node build/server.js）。
// 路径别名（@/*、next/server → shim）全部走 tsconfig.json paths —— esbuild 原生读取 tsconfig，
// 不在这里维护第二份别名配置（vitest 在 vitest.config.mts 单独声明，因为 Vite 不读 tsconfig paths）。
import { build } from "esbuild";

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
