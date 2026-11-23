import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: {
      // import.meta.dirname（Node >= 20.11）：避免 Vite configLoader 的 __dirname 兼容警告
      "@": path.resolve(import.meta.dirname, "src"),
      // 与 tsconfig paths 同步：route 单测构造 NextRequest 走 shim（见 src/server/next-shim.ts 头注释）
      "next/server": path.resolve(import.meta.dirname, "src/server/next-shim.ts"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // 并发上限 = CPU 核数 1/4（≤ 一半的硬性要求；测试文件各自要开 SQLite + undici，
    // 在共享/低内存机器上 50% 会把峰值 RSS 推高到触发 worker 被 OOM 的概率）
    maxWorkers: "25%",
    // 每个 fork 限定堆上限（Vitest 4：execArgv 已从 poolOptions 移到顶层；
    // poolOptions 在 Vitest 4 被移除，写在里面会被静默忽略）：
    // 个别重测试（32MB 请求体 / 快照上传）会让 worker 峰值 RSS 膨胀，
    // 在共享/低内存机器上容易触发系统 OOM kill（表现为 Worker exited unexpectedly）
    execArgv: ["--max-old-space-size=1536"],
    // 超时放宽：默认 hookTimeout=10s / testTimeout=5s 在共享或高负载机器上会误杀
    // 本身 <1s 的用例（首启 SQLite 迁移 + 路由模块 import 在 CPU 被抢占时可能超过 10s）。
    // 真实挂死仍会在 30s 内失败，不会掩盖问题。
    hookTimeout: 30_000,
    testTimeout: 30_000,
    teardownTimeout: 30_000,
  },
});
