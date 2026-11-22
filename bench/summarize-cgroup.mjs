/**
 * 汇总 cgroup v2 采样数据，分阶段给出：
 *   - current            cgroup memory.current（含 page cache）
 *   - statsUsage         current - inactive_file（Docker `docker stats` 的 MEM USAGE 口径）
 *   - anon               匿名内存 = 真实应用占用（V8 堆 + malloc）
 *   - file               page cache（含 node 二进制代码页）
 *
 * 用法：node bench/summarize-cgroup.mjs <cgroup.jsonl> <idleBeforeS> <loadS> <idleAfterS>
 */
import fs from "node:fs";

const [, , file, a, b, c] = process.argv;
const idleBefore = Number(a || 40);
const loadS = Number(b || 300);
const idleAfter = Number(c || 120);

const rows = fs
  .readFileSync(file, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

if (rows.length === 0) {
  console.log(JSON.stringify({ error: "no samples" }));
  process.exit(1);
}

const MB = 1048576;
const t0 = rows[0].t;
const enriched = rows.map((r, i) => {
  const t = r.t - t0;
  const phase = t < idleBefore ? "idleBefore" : t < idleBefore + loadS ? "load" : "idleAfter";
  // /proc/<pid>/stat 的 utime+stime 是 clock ticks（USER_HZ=100）
  let cpuPct = null;
  if (i > 0 && r.cpuTicks != null && rows[i - 1].cpuTicks != null) {
    const dt = r.t - rows[i - 1].t;
    const dTicks = r.cpuTicks - rows[i - 1].cpuTicks;
    if (dt > 0) cpuPct = +((dTicks / 100 / dt) * 100).toFixed(1);
  }
  return {
    t,
    phase,
    current: r.current / MB,
    anon: r.anon / MB,
    file: r.file / MB,
    inactiveFile: r.inactive_file / MB,
    statsUsage: (r.current - r.inactive_file) / MB,
    sock: r.sock / MB,
    slab: r.slab / MB,
    cpuPct,
  };
});

function stats(phase) {
  const s = enriched.filter((r) => r.phase === phase);
  if (s.length === 0) return null;
  const tail = s.slice(Math.floor(s.length * 0.7));
  const agg = (arr, k) => ({
    min: +Math.min(...arr.map((r) => r[k])).toFixed(1),
    max: +Math.max(...arr.map((r) => r[k])).toFixed(1),
    avg: +(arr.reduce((x, r) => x + r[k], 0) / arr.length).toFixed(1),
    tailAvg: +(tail.reduce((x, r) => x + r[k], 0) / tail.length).toFixed(1),
  });
  return {
    samples: s.length,
    current: agg(s, "current"),
    statsUsage: agg(s, "statsUsage"),
    anon: agg(s, "anon"),
    file: agg(s, "file"),
    sock: agg(s, "sock"),
    slab: agg(s, "slab"),
    cpuPct: (() => {
      const v = s.map((r) => r.cpuPct).filter((x) => x !== null && Number.isFinite(x));
      if (v.length === 0) return null;
      return {
        avg: +(v.reduce((a, b) => a + b, 0) / v.length).toFixed(1),
        max: +Math.max(...v).toFixed(1),
      };
    })(),
  };
}

const result = {
  file,
  samples: rows.length,
  windowS: +(rows[rows.length - 1].t - t0).toFixed(0),
  idleBefore: stats("idleBefore"),
  load: stats("load"),
  idleAfter: stats("idleAfter"),
  peakCurrent: +Math.max(...enriched.map((r) => r.current)).toFixed(1),
  peakAnon: +Math.max(...enriched.map((r) => r.anon)).toFixed(1),
  finalCurrent: +enriched[enriched.length - 1].current.toFixed(1),
  finalAnon: +enriched[enriched.length - 1].anon.toFixed(1),
  series: enriched.filter((_, i) => i % 5 === 0).map((r) => ({
    t: +r.t.toFixed(0),
    phase: r.phase,
    current: +r.current.toFixed(1),
    statsUsage: +r.statsUsage.toFixed(1),
    anon: +r.anon.toFixed(1),
    file: +r.file.toFixed(1),
    cpuPct: r.cpuPct,
  })),
};

console.log(JSON.stringify(result, null, 2));
