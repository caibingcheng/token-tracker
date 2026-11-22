/**
 * 用应用自身的迁移逻辑建表（bench 种子数据前必须先跑一次）。
 * 用法：SQLITE_DATABASE_PATH=... npx tsx bench/init-db.ts
 */
import { initDatabase, closeDb } from "../src/lib/db/index";

async function main() {
  await initDatabase();
  closeDb();
  console.log("schema ready:", process.env.SQLITE_DATABASE_PATH);
}

main();
