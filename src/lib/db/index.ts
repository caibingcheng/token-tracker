import { sql } from "drizzle-orm";
import { wrapDatabaseClient } from "./cache";

let db: any;
let tokenRecords: any;
let initialized = false;

export async function initDatabase() {
  if (initialized) return;
  await ensureClient();
  initialized = true;
}

async function ensureClient() {
  if (db) return;

  const { default: Database } = await import("better-sqlite3");
  const { mkdirSync } = await import("fs");
  const { dirname } = await import("path");
  const sqliteModule = await import("./schema-sqlite");

  const dbPath = process.env.SQLITE_DATABASE_PATH;
  if (!dbPath) {
    throw new Error("SQLITE_DATABASE_PATH environment variable is required");
  }

  mkdirSync(dirname(dbPath), { recursive: true });
  const client = new Database(dbPath);
  wrapDatabaseClient(client);

  const { drizzle } = await import("drizzle-orm/better-sqlite3");
  db = drizzle(client, { schema: sqliteModule });
  tokenRecords = sqliteModule.tokenRecords;

  client.exec(`
    CREATE TABLE IF NOT EXISTS token_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      model TEXT NOT NULL,
      provider TEXT NOT NULL,
      agent TEXT NOT NULL DEFAULT 'unknown',
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cache_read INTEGER NOT NULL DEFAULT 0,
      cache_write INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_token_records_created_at ON token_records(created_at);
    CREATE INDEX IF NOT EXISTS idx_token_records_provider_created_at ON token_records(provider, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_records_model_created_at ON token_records(model, created_at);
    CREATE INDEX IF NOT EXISTS idx_token_records_provider_model_created_at ON token_records(provider, model, created_at);
  `);

  console.log("[DB] SQLite initialized at:", dbPath);
}

export function getDateGroupExpr(granularity: string) {
  if (!tokenRecords) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }

  if (granularity === "week") {
    return sql<string>`strftime('%Y-%W', ${tokenRecords.createdAt})`;
  }
  if (granularity === "month") {
    return sql<string>`strftime('%Y-%m', ${tokenRecords.createdAt})`;
  }
  return sql<string>`strftime('%Y-%m-%d', ${tokenRecords.createdAt})`;
}

export { db, tokenRecords };
export type { TokenRecord, NewTokenRecord } from "./schema-sqlite";
