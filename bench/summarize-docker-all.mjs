/**
 * Docker 版对比汇总：读 bench/out/<label>/summary.json + loadgen.txt。
 * 单位 MB；current = cgroup memory.current（docker stats MEM USAGE 的主项）。
 * node bench/summarize-docker-all.mjs [label...]
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, "out");

const DEFAULT = [
  "db-before-stress",
  "db-after-stress",
  "db-before-real",
  "db-after-real",
  "db2-before",
  "db2-after",
];
const labels = process.argv.length > 2 ? process.argv.slice(2) : DEFAULT;
const pad = (v, n) => String(v ?? "-").padStart(n);

console.log(
  [
    "label".padEnd(18),
    pad("idle", 6),
    pad("loadTail", 9),
    pad("peak", 7),
    pad("afterTail", 10),
    pad("final", 6),
    pad("anonPeak", 9),
    pad("fileMax", 8),
    pad("cpuIdle%", 9),
    pad("cpuLoad%", 9),
    pad("rps", 6),
    pad("p95ms", 7),
    pad("fail", 5),
  ].join(" ")
);

for (const label of labels) {
  const sp = path.join(OUT, label, "summary.json");
  const lp = path.join(OUT, label, "loadgen.txt");
  if (!fs.existsSync(sp)) {
    console.log(`${label.padEnd(18)} (missing)`);
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
      label.padEnd(18),
      pad(s.idleBefore?.current?.tailAvg, 6),
      pad(s.load?.current?.tailAvg, 9),
      pad(s.load?.current?.max, 7),
      pad(s.idleAfter?.current?.tailAvg, 10),
      pad(s.finalCurrent, 6),
      pad(s.peakAnon, 9),
      pad(s.load?.file?.max, 8),
      pad(s.idleBefore?.cpuPct?.avg, 9),
      pad(s.load?.cpuPct?.avg, 9),
      pad(load.rps, 6),
      pad(load.latency?.p95, 7),
      pad(load.fail, 5),
    ].join(" ")
  );
}
