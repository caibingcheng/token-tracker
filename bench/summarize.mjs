/**
 * 把 probe.jsonl 按阶段聚合。
 * node bench/summarize.mjs <probe.jsonl> <idleBeforeS> <loadS> <idleAfterS>
 */
import fs from "node:fs";

const [, , file, idleBeforeArg, loadArg, idleAfterArg] = process.argv;
const idleBefore = Number(idleBeforeArg || 40);
const loadS = Number(loadArg || 300);
const idleAfter = Number(idleAfterArg || 90);

const rows = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

if (rows.length === 0) {
  console.log(JSON.stringify({ error: "no probe samples" }));
  process.exit(1);
}

const t0 = rows[0].t;
const withPhase = rows.map((r) => {
  const t = (r.t - t0) / 1000;
  const phase = t < idleBefore ? "idleBefore" : t < idleBefore + loadS ? "load" : "idleAfter";
  return { ...r, t: +t.toFixed(1), phase };
});

function stats(phase) {
  const s = withPhase.filter((r) => r.phase === phase);
  if (s.length === 0) return null;
  const pick = (k) => s.map((r) => r[k]);
  const avg = (a) => +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
  const max = (a) => +Math.max(...a).toFixed(1);
  const min = (a) => +Math.min(...a).toFixed(1);
  // 稳态 = 该阶段后 30% 采样的均值（避开启动尖峰）
  const tail = s.slice(Math.floor(s.length * 0.7));
  const tailAvg = (k) => +(tail.reduce((x, r) => x + r[k], 0) / tail.length).toFixed(1);
  return {
    samples: s.length,
    rssMin: min(pick("rssMB")),
    rssMax: max(pick("rssMB")),
    rssAvg: avg(pick("rssMB")),
    rssTailAvg: tailAvg("rssMB"),
    heapUsedMax: max(pick("heapUsedMB")),
    heapUsedTailAvg: tailAvg("heapUsedMB"),
    heapTotalMax: max(pick("heapTotalMB")),
    externalMax: max(pick("externalMB")),
    arrayBuffersMax: max(pick("arrayBuffersMB")),
    cpuAvgPct: avg(pick("cpuPct")),
    cpuMaxPct: max(pick("cpuPct")),
  };
}

const result = {
  file,
  samples: rows.length,
  totalWindowS: +((rows[rows.length - 1].t - t0) / 1000).toFixed(1),
  idleBefore: stats("idleBefore"),
  load: stats("load"),
  idleAfter: stats("idleAfter"),
  peakRss: +Math.max(...rows.map((r) => r.rssMB)).toFixed(1),
  finalRss: rows[rows.length - 1].rssMB,
  series: withPhase.filter((_, i) => i % 3 === 0).map((r) => ({
    t: r.t,
    phase: r.phase,
    rssMB: r.rssMB,
    heapUsedMB: r.heapUsedMB,
    externalMB: r.externalMB,
    cpuPct: r.cpuPct,
  })),
};

console.log(JSON.stringify(result, null, 2));
