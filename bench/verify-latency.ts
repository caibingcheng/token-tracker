/**
 * 验证 queryLatencyStats 的游标路径与「全量数组 + 聚合函数」路径结果完全一致。
 * 用法：SQLITE_DATABASE_PATH=bench/data/bench.db GATEWAY_SECRET=... npx tsx bench/verify-latency.ts
 *
 * 覆盖点：
 * 1. raw(true) 的列顺序与 select 顺序一致（错位会立刻表现为数值不同）
 * 2. toSQL() 的参数绑定正确（where 条件生效）
 * 3. 增量聚合与数组聚合的数值/排序完全相等
 */
import { db, tokenRecords, initDatabase, closeDb } from "../src/lib/db/index";
import {
  queryLatencyStats,
  aggregateLatencyByModel,
  aggregateLatencyDaily,
  aggregateLatencyByModelByDate,
  loadActiveModelSet,
  type LatencyRow,
} from "../src/lib/latency-query";

function fail(msg: string): never {
  console.error("FAIL:", msg);
  process.exit(1);
}

async function main() {
  await initDatabase();

  const tz = 0;
  const groups: never[] = [];
  const aliases: never[] = [];

  // range=9999 天 → where 只会放行「过去 9999 天」，等价全表
  const viaCursor = await queryLatencyStats({
    range: "9999",
    providerFilter: null,
    modelFilter: null,
    agentUaFilter: null,
    timezoneOffsetMinutes: tz,
    groups,
    aliases,
  });

  const activeModels = await loadActiveModelSet();
  const rows = (await db
    .select({
      model: tokenRecords.model,
      provider: tokenRecords.provider,
      ttftMs: tokenRecords.ttftMs,
      latencyMs: tokenRecords.latencyMs,
      outputTokens: tokenRecords.outputTokens,
      createdAt: tokenRecords.createdAt,
    })
    .from(tokenRecords)) as LatencyRow[];

  const viaArray = {
    byModel: aggregateLatencyByModel(rows, activeModels, groups, aliases),
    daily: aggregateLatencyDaily(rows, tz),
    dailyByModel: aggregateLatencyByModelByDate(rows, activeModels, tz, groups, aliases),
  };

  console.log(`rows=${rows.length} byModel=${viaCursor.byModel.length} daily=${viaCursor.daily.length} dailyByModel=${Object.keys(viaCursor.dailyByModel).length}`);

  const a = JSON.stringify(viaCursor);
  const b = JSON.stringify(viaArray);
  if (a !== b) {
    // 找出第一个差异位置
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    console.error("cursor:", a.slice(Math.max(0, i - 120), i + 120));
    console.error("array :", b.slice(Math.max(0, i - 120), i + 120));
    fail("cursor path != array path");
  }

  const sample = viaCursor.byModel[0];
  console.log("first byModel:", JSON.stringify(sample));
  console.log("first daily:", JSON.stringify(viaCursor.daily[0]));

  // 冒烟：数值必须不是 NaN/undefined
  for (const s of viaCursor.byModel) {
    if (s.count <= 0) fail(`bad count for ${s.model}`);
    if (s.streamCount > 0 && (s.avgTtftMs === null || !Number.isFinite(s.avgTtftMs))) {
      fail(`bad avgTtftMs for ${s.model}`);
    }
  }

  console.log("OK: cursor path matches array path exactly");
  closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
