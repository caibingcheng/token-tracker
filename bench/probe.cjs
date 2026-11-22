/**
 * 进程内探针：通过 NODE_OPTIONS="--require <此文件>" 注入被测进程，
 * 不改动应用代码。每 2s 把 memoryUsage + cpuUsage 追加到 PROBE_OUT（JSONL）。
 */
const fs = require("node:fs");

const OUT = process.env.PROBE_OUT;
if (OUT) {
  const INTERVAL = Number(process.env.PROBE_INTERVAL_MS || 2000);
  try {
    fs.writeFileSync(OUT, "");
  } catch {
    /* dir may not exist yet */
  }
  let lastCpu = process.cpuUsage();
  const timer = setInterval(() => {
    const m = process.memoryUsage();
    const cpu = process.cpuUsage(lastCpu);
    lastCpu = process.cpuUsage();
    const elapsedUs = INTERVAL * 1000;
    const line = JSON.stringify({
      t: Date.now(),
      rssMB: +(m.rss / 1048576).toFixed(1),
      heapTotalMB: +(m.heapTotal / 1048576).toFixed(1),
      heapUsedMB: +(m.heapUsed / 1048576).toFixed(1),
      externalMB: +(m.external / 1048576).toFixed(1),
      arrayBuffersMB: +(m.arrayBuffers / 1048576).toFixed(1),
      cpuPct: +(((cpu.user + cpu.system) / elapsedUs) * 100).toFixed(1),
      uptimeS: Math.round(process.uptime()),
      gcAvailable: typeof globalThis.gc === "function",
    });
    try {
      fs.appendFileSync(OUT, line + "\n");
    } catch {
      /* ignore */
    }
  }, INTERVAL);
  timer.unref();
}
