/**
 * 用 docker stats 口径（current - inactive_file）重算所有指标。
 * cgroup 的 file 记账受「哪个容器先 fault 了这个文件页」影响，current 不可跨轮次比较；
 * statsUsage 会扣掉 inactive_file，受影响小得多。anon 则完全不受影响。
 * node bench/recalc-stats-usage.mjs <label...>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");
const labels = process.argv.length > 2 ? process.argv.slice(2) : [];
const MB = 1048576;
const pad = (v, n) => String(v ?? "-").padStart(n);

console.log(
  [
    "label".padEnd(20),
    pad("idle", 6),
    pad("loadTail", 9),
    pad("peak", 7),
    pad("afterTail", 10),
    pad("|anonIdle", 10),
    pad("anonPeak", 9),
    pad("anonAfter", 10),
    pad("fileMax", 8),
  ].join(" ")
);

for (const label of labels) {
  const p = path.join(OUT, label, "cgroup.jsonl");
  if (!fs.existsSync(p)) {
    console.log(`${label}: missing`);
    continue;
  }
  const rows = fs
    .readFileSync(p, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
  const t0 = rows[0].t;
  // 复算阶段边界：从 summary.json 读，避免重复传参
  const sum = JSON.parse(fs.readFileSync(path.join(OUT, label, "summary.json"), "utf8"));
  const nIdle = sum.idleBefore.samples;
  const nLoad = sum.load.samples;
  const tail = (arr) => arr.slice(Math.floor(arr.length * 0.7));
  const avg = (a) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);

  const en = rows.map((r) => ({
    t: r.t - t0,
    stats: (r.current - r.inactive_file) / MB,
    anon: r.anon / MB,
    file: r.file / MB,
  }));
  const idle = en.slice(0, nIdle);
  const load = en.slice(nIdle, nIdle + nLoad);
  const after = en.slice(nIdle + nLoad);

  console.log(
    [
      label.padEnd(20),
      pad(avg(tail(idle).map((r) => r.stats)), 6),
      pad(avg(tail(load).map((r) => r.stats)), 9),
      pad(Math.max(...load.map((r) => r.stats)).toFixed(1), 7),
      pad(avg(tail(after).map((r) => r.stats)), 10),
      pad(avg(tail(idle).map((r) => r.anon)), 10),
      pad(Math.max(...load.map((r) => r.anon)).toFixed(1), 9),
      pad(avg(tail(after).map((r) => r.anon)), 10),
      pad(Math.max(...load.map((r) => r.file)).toFixed(1), 8),
    ].join(" ")
  );
}
