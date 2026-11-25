/**
 * 把 bench 数据目录里的 models.dev 快照 fetchedAt 改成当前时间，
 * 避免压测期间触发 7 天 TTL 的后台刷新（真实生产也会有同样的快照常驻）。
 * node bench/fix-snapshot.mjs <path>
 */
import fs from "node:fs";
import { guardBenchPath } from "./lib/guard.mjs";

let p;
try {
  p = guardBenchPath(
    process.argv[2] || "bench/data/models-dev-cache.json",
    "snapshot file"
  );
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
}
const j = JSON.parse(fs.readFileSync(p, "utf8"));
j.fetchedAt = new Date().toISOString();
fs.writeFileSync(p, JSON.stringify(j));
console.log("snapshot refreshed:", p, j.fetchedAt, (fs.statSync(p).size / 1048576).toFixed(1) + "MB");
