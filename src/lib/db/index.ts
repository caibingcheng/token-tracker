import { sql } from "drizzle-orm";
import { wrapDatabaseClient } from "./cache";
import { offsetMinutesToSqlModifiers } from "@/lib/timezone-utils";

let db: any;
let tokenRecords: any;
let upstreamsTable: any;
let upstreamKeysTable: any;
let virtualKeysTable: any;
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
  upstreamsTable = sqliteModule.upstreams;
  upstreamKeysTable = sqliteModule.upstreamKeys;
  virtualKeysTable = sqliteModule.virtualKeys;

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

  migrateTokenRecordsColumns(client);

  client.exec(`
    CREATE TABLE IF NOT EXISTS upstreams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      protocol TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled_models TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE IF NOT EXISTS upstream_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
      api_key_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_status TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE INDEX IF NOT EXISTS idx_upstream_keys_upstream_id ON upstream_keys(upstream_id);
    CREATE TABLE IF NOT EXISTS virtual_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      api_key_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);

  console.log("[DB] SQLite initialized at:", dbPath);
}

// 存量 token_records 表不会通过 CREATE TABLE IF NOT EXISTS 补列，
// 通过 PRAGMA table_info 检测缺失列并 ALTER TABLE 添加。
function migrateTokenRecordsColumns(client: any): void {
  const columns: string[] = client.prepare("PRAGMA table_info(token_records)").all().map((c: any) => c.name);
  if (!columns.includes("status")) {
    client.exec("ALTER TABLE token_records ADD COLUMN status TEXT");
  }
  if (!columns.includes("latency_ms")) {
    client.exec("ALTER TABLE token_records ADD COLUMN latency_ms INTEGER");
  }
}

export function getDateGroupExpr(
  granularity: string,
  timezoneOffsetMinutes?: number
) {
  if (!tokenRecords) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }

  const modifiers =
    timezoneOffsetMinutes !== undefined
      ? offsetMinutesToSqlModifiers(timezoneOffsetMinutes)
      : [];

  if (granularity === "week") {
    if (modifiers.length === 0) {
      return sql<string>`strftime('%Y-%W', ${tokenRecords.createdAt})`;
    }
    if (modifiers.length === 1) {
      return sql<string>`strftime('%Y-%W', ${tokenRecords.createdAt}, ${modifiers[0]})`;
    }
    return sql<string>`strftime('%Y-%W', ${tokenRecords.createdAt}, ${modifiers[0]}, ${modifiers[1]})`;
  }

  if (granularity === "month") {
    if (modifiers.length === 0) {
      return sql<string>`strftime('%Y-%m', ${tokenRecords.createdAt})`;
    }
    if (modifiers.length === 1) {
      return sql<string>`strftime('%Y-%m', ${tokenRecords.createdAt}, ${modifiers[0]})`;
    }
    return sql<string>`strftime('%Y-%m', ${tokenRecords.createdAt}, ${modifiers[0]}, ${modifiers[1]})`;
  }

  if (granularity === "hour") {
    if (modifiers.length === 0) {
      return sql<string>`strftime('%H', ${tokenRecords.createdAt})`;
    }
    if (modifiers.length === 1) {
      return sql<string>`strftime('%H', ${tokenRecords.createdAt}, ${modifiers[0]})`;
    }
    return sql<string>`strftime('%H', ${tokenRecords.createdAt}, ${modifiers[0]}, ${modifiers[1]})`;
  }

  if (modifiers.length === 0) {
    return sql<string>`strftime('%Y-%m-%d', ${tokenRecords.createdAt})`;
  }
  if (modifiers.length === 1) {
    return sql<string>`strftime('%Y-%m-%d', ${tokenRecords.createdAt}, ${modifiers[0]})`;
  }
  return sql<string>`strftime('%Y-%m-%d', ${tokenRecords.createdAt}, ${modifiers[0]}, ${modifiers[1]})`;
}

export { db, tokenRecords, upstreamsTable, upstreamKeysTable, virtualKeysTable };
export type { TokenRecord, NewTokenRecord } from "./schema-sqlite";
