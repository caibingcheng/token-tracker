/**
 * bench 脚本共用的守卫：
 * - guardBenchPath：任何 bench 读写的文件都必须落在 bench/ 目录内，
 *   杜绝误用（或误建/误迁移）仓库里真正在用的 data/token-tracker.db
 * - benchSecret：凭据一律来自 bench/.state/（由 lib/env.sh 自动生成），不写死在仓库
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_HOME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

export function guardBenchPath(p, what = "path") {
  if (!p || typeof p !== "string") {
    throw new Error(`bench: ${what} is required`);
  }
  const abs = path.resolve(p);
  const root = BENCH_HOME + path.sep;
  if (abs !== BENCH_HOME && !abs.startsWith(root)) {
    throw new Error(
      `bench: refusing to touch ${what} outside ${BENCH_HOME}: ${p}\n` +
        "bench must only use its own scratch files (bench/data, bench/docker-data)"
    );
  }
  return abs;
}

export function benchSecret() {
  const s = process.env.GATEWAY_SECRET;
  if (!s) {
    throw new Error(
      "GATEWAY_SECRET missing; run the shell wrappers (they call bench_init_secrets) " +
        "or export one manually"
    );
  }
  return s;
}

export function benchVirtualKey() {
  const vk = process.env.BENCH_VK;
  if (!vk) {
    throw new Error(
      "BENCH_VK missing; run the shell wrappers (they call bench_init_secrets) " +
        "or export one manually"
    );
  }
  return vk;
}
