/**
 * 汇总所有 bench/out/<label>/summary.json + loadgen.txt，输出对比表。
 * node bench/summarize-all.mjs [label...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");

const DEFAULT_LABELS = [
  "A-256",
  "E-latency",
  "J-trim",
  "P-final",
  "Q-realistic",
  "R-gw-only",
];
const labels = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT_LABELS;

const pad = (v, n) => String(v ?? "-").padStart(n);

console.log(
  [
    "label".padEnd(14),
    pad("idle", 7),
    pad("load", 7),
    pad("peak", 7),
    pad("after", 7),
    pad("heapUsed", 9),
    pad("heapTotal", 10),
    pad("cpuLoad%", 9),
    pad("cpuIdle%", 9),
    pad("rps", 7),
    pad("p95ms", 8),
    pad("fail", 6),
  ].join(" ")
);

for (const label of labels) {
  const sp = path.join(OUT, label, "summary.json");
  const lp = path.join(OUT, label, "loadgen.txt");
  if (!fs.existsSync(sp)) {
    console.log(`${label.padEnd(14)} (missing summary.json)`);
    continue;
  }
  const s = JSON.parse(fs.readFileSync(sp, "utf8"));
  let load = {};
  if (fs.existsSync(lp)) {
    const m = fs.readFileSync(lp, "utf8").match(/BENCH_RESULT (\{.*\})/);
    if (m) load = JSON.parse(m[1]);
  }
  console.log(
    [
      label.padEnd(14),
      pad(s.idleBefore?.rssTailAvg, 7),
      pad(s.load?.rssTailAvg, 7),
      pad(s.load?.rssMax, 7),
      pad(s.idleAfter?.rssTailAvg, 7),
      pad(s.load?.heapUsedMax, 9),
      pad(s.load?.heapTotalMax, 10),
      pad(s.load?.cpuAvgPct, 9),
      pad(s.idleBefore?.cpuAvgPct, 9),
      pad(load.rps, 7),
      pad(load.latency?.p95, 8),
      pad(load.fail, 6),
    ].join(" ")
  );
}
