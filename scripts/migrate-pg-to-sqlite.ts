import dotenv from "dotenv";
dotenv.config({ path: ".env.local" });
import { Pool } from "pg";
import Database from "better-sqlite3";
import path from "node:path";

const PG_URL = process.env.DATABASE_URL;
const SQLITE_PATH =
  process.env.SQLITE_DATABASE_PATH || "./data/token-tracker.db";

async function migrate() {
  if (!PG_URL) {
    console.error("请设置 DATABASE_URL 环境变量指向 PostgreSQL 数据库");
    process.exit(1);
  }

  // 1. 连接 PostgreSQL
  const pgPool = new Pool({ connectionString: PG_URL });
  const { rows } = await pgPool.query(
    'SELECT * FROM token_records ORDER BY id'
  );
  console.log(`从 PostgreSQL 读取了 ${rows.length} 条记录`);

  if (rows.length === 0) {
    console.log("没有数据需要迁移");
    await pgPool.end();
    return;
  }

  // 2. 连接 SQLite（确保数据库已初始化）
  const dbPath = path.resolve(SQLITE_PATH);
  const sqlite = new Database(dbPath);

  // 清空现有数据（从最大 id 开始删避免外键约束问题）
  sqlite.exec("DELETE FROM token_records");
  console.log("已清空 SQLite 中的现有数据");

  // 3. 插入数据
  const insert = sqlite.prepare(`
    INSERT INTO token_records (id, model, provider, agent, input_tokens, output_tokens, cache_read, cache_write, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  const insertAll = sqlite.transaction((records: typeof rows) => {
    for (const r of records) {
      insert.run(
        r.id,
        r.model,
        r.provider,
        r.agent || "unknown",
        r.input_tokens,
        r.output_tokens,
        r.cache_read,
        r.cache_write,
        r.created_at instanceof Date
          ? r.created_at.toISOString()
          : r.created_at,
      );
    }
  });

  insertAll(rows);
  console.log(`成功写入 SQLite ${rows.length} 条记录`);

  await pgPool.end();
  sqlite.close();
}

migrate().catch((err) => {
  console.error("迁移失败:", err);
  process.exit(1);
});
