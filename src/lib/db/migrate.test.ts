import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { migrateColumns } from "./migrate";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;
let db: InstanceType<typeof Database>;

const TABLES = [
  {
    table: "token_records",
    columns: [
      { name: "status", definition: "status TEXT" },
      { name: "latency_ms", definition: "latency_ms INTEGER" },
      { name: "virtual_key_id", definition: "virtual_key_id INTEGER" },
      { name: "user_agent", definition: "user_agent TEXT" },
    ],
  },
  {
    table: "virtual_keys",
    columns: [
      { name: "comment", definition: "comment TEXT" },
      { name: "enabled_models", definition: "enabled_models TEXT NOT NULL DEFAULT '[\"*\"]'" },
      { name: "max_rpm", definition: "max_rpm INTEGER" },
      { name: "max_tpm", definition: "max_tpm INTEGER" },
      { name: "max_daily_tokens", definition: "max_daily_tokens INTEGER" },
      { name: "max_monthly_tokens", definition: "max_monthly_tokens INTEGER" },
    ],
  },
  {
    table: "upstreams",
    columns: [
      { name: "balance", definition: "balance TEXT" },
      { name: "balance_updated_at", definition: "balance_updated_at TEXT" },
    ],
  },
];

function tableColumns(t: string): string[] {
  return db.prepare(`PRAGMA table_info(${t})`).all().map((c: any) => c.name);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-migrate-"));
  db = new Database(join(dir, "test.db"));
  // 模拟旧库：只建基础列
  db.exec(`
    CREATE TABLE token_records (
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
    CREATE TABLE virtual_keys (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      api_key_encrypted TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    CREATE TABLE upstreams (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      protocol TEXT NOT NULL,
      base_url TEXT NOT NULL,
      enabled_models TEXT NOT NULL DEFAULT '[]',
      priority INTEGER NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
  `);
});

afterAll(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("migrateColumns", () => {
  it("adds missing columns to legacy tables", () => {
    expect(tableColumns("token_records")).not.toContain("status");
    expect(tableColumns("virtual_keys")).not.toContain("enabled_models");

    migrateColumns(db, TABLES);

    expect(tableColumns("token_records")).toEqual(
      expect.arrayContaining(["status", "latency_ms", "virtual_key_id", "user_agent"])
    );
    expect(tableColumns("virtual_keys")).toEqual(
      expect.arrayContaining([
        "comment",
        "enabled_models",
        "max_rpm",
        "max_tpm",
        "max_daily_tokens",
        "max_monthly_tokens",
      ])
    );
    expect(tableColumns("upstreams")).toEqual(
      expect.arrayContaining(["balance", "balance_updated_at"])
    );
  });

  it("is idempotent on a fully migrated schema", () => {
    migrateColumns(db, TABLES);
    migrateColumns(db, TABLES);
    // 不重复添加列，列顺序与数量保持不变
    expect(tableColumns("token_records").filter((c) => c === "virtual_key_id")).toHaveLength(1);
    expect(tableColumns("virtual_keys").filter((c) => c === "enabled_models")).toHaveLength(1);
  });

  it("backfills NOT NULL DEFAULT columns for existing rows", () => {
    db.exec(`INSERT INTO virtual_keys (name, api_key_encrypted) VALUES ('legacy', 'x')`);
    const row: any = db
      .prepare(`SELECT enabled_models FROM virtual_keys WHERE name = 'legacy'`)
      .get();
    expect(row.enabled_models).toBe('["*"]');
  });

  it("leaves untouched tables alone", () => {
    db.exec(`CREATE TABLE unrelated (id INTEGER PRIMARY KEY)`);
    migrateColumns(db, [{ table: "unrelated", columns: [{ name: "x", definition: "x TEXT" }] }]);
    expect(tableColumns("unrelated")).toEqual(["id", "x"]);
  });
});
