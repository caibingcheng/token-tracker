/**
 * 用应用自身的迁移逻辑建表（bench 种子数据前必须先跑一次）。
 *
 * 用法：npx tsx bench/init-db.ts <dbPath>
 *
 * dbPath 必须落在 bench/ 目录内 —— 这个脚本会执行 CREATE TABLE / ALTER TABLE，
 * 指错路径会改掉真正在用的库。所以不接受默认值，也不读仓库默认的 data/token-tracker.db。
 */
import { guardBenchPath } from "./lib/guard.mjs";

async function main() {
  const dbPath = guardBenchPath(
    process.argv[2] || process.env.SQLITE_DATABASE_PATH,
    "database"
  );
  // 必须在 import 应用模块之前落到 env：db 模块按懒初始化读取它
  process.env.SQLITE_DATABASE_PATH = dbPath;

  const { initDatabase, closeDb } = await import("../src/lib/db/index");
  await initDatabase();
  closeDb();
  console.log("schema ready:", dbPath);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
