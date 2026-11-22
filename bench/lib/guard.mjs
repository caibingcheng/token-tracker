/**
 * bench 脚本共用的守卫：
 * - guardBenchPath：任何 bench 读写的文件都必须落在 bench/ 目录内，
 *   杜绝误用（或误建/误迁移）仓库里真正在用的 data/token-tracker.db
 * - benchSecret：凭据一律来自 bench/.state/（由 lib/env.sh 自动生成），不写死在仓库
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const BENCH_HOME = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  ".."
);

// 符号链接会绕过单纯的 path.resolve 比较（bench/e2e-data -> ../data 就能让 bench 去删真实库），
// 所以逐段走：遇到符号链接就 readlink 后从目标重新开始，**不存的部分原样拼接**。
// 逐段而非 realpathSync 的原因：悬空符号链接（目标尚不存在）在 realpathSync 下直接 ENOENT，
// 那样会回退成「按字面路径判断」从而放行，正是要防的绕过。与 shell 侧 `realpath -m` 同口径。
function realpathNearest(target) {
  return walk(path.resolve(target));
}

function walk(abs) {
  const parts = abs.split(path.sep);
  let cur = parts[0] + path.sep; // Windows 盘符 "C:\\"，POSIX "/"
  for (let i = 1; i < parts.length; i++) {
    if (!parts[i]) continue;
    const next = path.join(cur, parts[i]);
    let st;
    try {
      st = fs.lstatSync(next);
    } catch {
      return path.join(cur, ...parts.slice(i));
    }
    if (st.isSymbolicLink()) {
      let linkTarget;
      try {
        linkTarget = fs.readlinkSync(next);
      } catch {
        return next; // 读不到链接目标：拒绝在调用方按「不在 bench 内」处理
      }
      const resolved = path.isAbsolute(linkTarget)
        ? linkTarget
        : path.join(cur, linkTarget);
      return walk(path.join(resolved, ...parts.slice(i + 1)));
    }
    cur = next;
  }
  try {
    return fs.realpathSync(cur); // 全部存在：归一大小写 / 8.3 短路径
  } catch {
    return cur;
  }
}

export function guardBenchPath(p, what = "path") {
  if (!p || typeof p !== "string") {
    throw new Error(`bench: ${what} is required`);
  }
  const abs = realpathNearest(p);
  const home = realpathNearest(BENCH_HOME);
  const root = home + path.sep;
  if (abs !== home && !abs.startsWith(root)) {
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
