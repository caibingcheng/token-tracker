import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { migrateColumns, migrateTokenRecordsModelColumns, migrateRoutingRulesTable, migrateSyncInstancesTable, migrateIngestTokensTable } from "./migrate";
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
      { name: "ttft_ms", definition: "ttft_ms INTEGER" },
      { name: "virtual_key_id", definition: "virtual_key_id INTEGER" },
      { name: "user_agent", definition: "user_agent TEXT" },
      { name: "remote_instance_uid", definition: "remote_instance_uid TEXT" },
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
      expect.arrayContaining(["status", "latency_ms", "ttft_ms", "virtual_key_id", "user_agent", "remote_instance_uid"])
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

  it("leaves ttft_ms NULL for pre-existing rows (not backfilled)", () => {
    // 模拟旧库：latency_ms 已有值但无 ttft_ms 概念
    db.exec(`INSERT INTO token_records (model, provider, status, latency_ms) VALUES ('gpt-4o', 'openai', 'ok', 1234)`);
    migrateColumns(db, TABLES);
    const row: any = db
      .prepare(`SELECT latency_ms, ttft_ms, remote_instance_uid FROM token_records WHERE model = 'gpt-4o'`)
      .get();
    expect(row.latency_ms).toBe(1234);
    expect(row.ttft_ms).toBeNull();
    expect(row.remote_instance_uid).toBeNull(); // 存量 remote 行不回填
  });

  it("leaves untouched tables alone", () => {
    db.exec(`CREATE TABLE unrelated (id INTEGER PRIMARY KEY)`);
    migrateColumns(db, [{ table: "unrelated", columns: [{ name: "x", definition: "x TEXT" }] }]);
    expect(tableColumns("unrelated")).toEqual(["id", "x"]);
  });
});

describe("migrateTokenRecordsModelColumns", () => {
  let dir2: string;
  let db2: InstanceType<typeof Database>;

  beforeAll(() => {
    dir2 = mkdtempSync(join(tmpdir(), "tt-migrate-tr-"));
    db2 = new Database(join(dir2, "test.db"));
    // 模拟旧 schema：含 target_model，无 request_model
    db2.exec(`
      CREATE TABLE token_records (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        model TEXT NOT NULL,
        provider TEXT NOT NULL,
        agent TEXT NOT NULL DEFAULT 'unknown',
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read INTEGER NOT NULL DEFAULT 0,
        cache_write INTEGER NOT NULL DEFAULT 0,
        status TEXT,
        latency_ms INTEGER,
        virtual_key_id INTEGER,
        user_agent TEXT,
        target_model TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO token_records (model, provider, target_model) VALUES
        ('my-alias', 'openai', 'gpt-4o-real'),
        ('plain-model', 'openai', NULL);
    `);
  });

  afterAll(() => {
    db2.close();
    rmSync(dir2, { recursive: true, force: true });
  });

  it("adds request_model, backfills it from model, moves target_model into model, drops target_model", () => {
    migrateTokenRecordsModelColumns(db2);

    const cols = db2.prepare(`PRAGMA table_info(token_records)`).all().map((c: any) => c.name);
    expect(cols).toContain("request_model");
    expect(cols).not.toContain("target_model");

    const rows: any[] = db2
      .prepare(`SELECT model, request_model FROM token_records ORDER BY id`)
      .all();
    expect(rows[0]).toEqual({ model: "gpt-4o-real", request_model: "my-alias" });
    expect(rows[1]).toEqual({ model: "plain-model", request_model: "plain-model" });
  });

  it("is idempotent on re-run", () => {
    migrateTokenRecordsModelColumns(db2);
    migrateTokenRecordsModelColumns(db2);

    const cols = db2.prepare(`PRAGMA table_info(token_records)`).all().map((c: any) => c.name);
    expect(cols).toContain("request_model");
    expect(cols).not.toContain("target_model");
    const rows: any[] = db2
      .prepare(`SELECT model, request_model FROM token_records ORDER BY id`)
      .all();
    expect(rows[0]).toEqual({ model: "gpt-4o-real", request_model: "my-alias" });
    expect(rows[1]).toEqual({ model: "plain-model", request_model: "plain-model" });
  });
});

describe("migrateRoutingRulesTable", () => {
  let dir3: string;
  let db3: InstanceType<typeof Database>;

  beforeAll(() => {
    dir3 = mkdtempSync(join(tmpdir(), "tt-migrate-rr-"));
    db3 = new Database(join(dir3, "test.db"));
    // 模拟旧 schema：UNIQUE(name, protocol) 单目标结构（无 priority 列）
    db3.exec(`
      CREATE TABLE upstreams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        protocol TEXT NOT NULL,
        base_url TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE routing_rules (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
        target_model TEXT NOT NULL,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE(name, protocol)
      );
      INSERT INTO upstreams (name, protocol, base_url) VALUES
        ('up-a', 'openai', 'https://a.example'),
        ('up-b', 'openai', 'https://b.example');
      INSERT INTO routing_rules (name, protocol, upstream_id, target_model) VALUES
        ('my-alias', 'openai', 1, 'gpt-4o-real'),
        ('other-alias', 'openai', 2, 'deepseek-chat');
    `);
  });

  afterAll(() => {
    db3.close();
    rmSync(dir3, { recursive: true, force: true });
  });

  it("adds priority column, rebuilds table with new unique key and preserves data", () => {
    migrateRoutingRulesTable(db3);

    expect(db3.prepare(`PRAGMA table_info(routing_rules)`).all().map((c: any) => c.name)).toEqual(
      expect.arrayContaining(["priority"])
    );

    const rows: any[] = db3
      .prepare(`SELECT name, protocol, upstream_id, target_model, priority FROM routing_rules ORDER BY id`)
      .all();
    expect(rows).toEqual([
      { name: "my-alias", protocol: "openai", upstream_id: 1, target_model: "gpt-4o-real", priority: 0 },
      { name: "other-alias", protocol: "openai", upstream_id: 2, target_model: "deepseek-chat", priority: 0 },
    ]);

    // 旧约束已换成新约束：同名同协议不同 upstream 允许插入（旧 UNIQUE 下会失败）
    db3.exec(
      `INSERT INTO routing_rules (name, protocol, upstream_id, target_model, priority) VALUES ('my-alias', 'openai', 2, 'gpt-4o-other', 1)`
    );
    const inserted: any = db3
      .prepare(`SELECT upstream_id, priority FROM routing_rules WHERE name = 'my-alias' AND upstream_id = 2`)
      .get();
    expect(inserted).toEqual({ upstream_id: 2, priority: 1 });

    // 同 name+protocol+upstream 重复 → 约束拒绝
    expect(() =>
      db3.exec(
        `INSERT INTO routing_rules (name, protocol, upstream_id, target_model) VALUES ('my-alias', 'openai', 1, 'dup')`
      )
    ).toThrow(/UNIQUE/i);
  });

  it("is idempotent on re-run and preserves data written after first migration", () => {
    migrateRoutingRulesTable(db3);
    migrateRoutingRulesTable(db3);
    const count: any = db3.prepare(`SELECT COUNT(*) AS c FROM routing_rules`).get();
    expect(count.c).toBe(3); // 2 条旧数据 + 1 条迁移后插入
    expect(db3.prepare(`PRAGMA table_info(routing_rules)`).all().map((c: any) => c.name)).toEqual(
      expect.arrayContaining(["priority"])
    );
  });
});

describe("migrateSyncInstancesTable", () => {
  let dir4: string;
  let db4: InstanceType<typeof Database>;

  beforeAll(() => {
    dir4 = mkdtempSync(join(tmpdir(), "tt-migrate-si-"));
    db4 = new Database(join(dir4, "test.db"));
    // 模拟旧 schema：instance 主键（无 uid 列）
    db4.exec(`
      CREATE TABLE sync_instances (
        instance TEXT PRIMARY KEY,
        epoch TEXT NOT NULL,
        last_record_id INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT
      );
      INSERT INTO sync_instances (instance, epoch, last_record_id, updated_at) VALUES
        ('bing-mbp', 'e1', 42, '2026-09-01T10:00:00.000Z');
    `);
  });

  afterAll(() => {
    db4.close();
    rmSync(dir4, { recursive: true, force: true });
  });

  it("rebuilds to uid PK + instance_name, drops legacy rows", () => {
    migrateSyncInstancesTable(db4);

    const cols = db4.prepare(`PRAGMA table_info(sync_instances)`).all().map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["uid", "instance_name", "epoch", "last_record_id", "updated_at"]));
    expect(cols).not.toContain("instance");

    // 旧行丢弃（协议已破坏，必然重绑重推）
    const count: any = db4.prepare(`SELECT COUNT(*) AS c FROM sync_instances`).get();
    expect(count.c).toBe(0);

    // 新结构按 uid 写入可用
    db4.exec(`INSERT INTO sync_instances (uid, instance_name, epoch, last_record_id) VALUES ('u-aaa', 'new-host', 'e2', 7)`);
  });

  it("is idempotent on re-run and preserves rows written after migration", () => {
    migrateSyncInstancesTable(db4);
    migrateSyncInstancesTable(db4);
    const row: any = db4
      .prepare(`SELECT uid, instance_name, last_record_id FROM sync_instances WHERE uid = 'u-aaa'`)
      .get();
    expect(row).toEqual({ uid: "u-aaa", instance_name: "new-host", last_record_id: 7 });
  });
});

describe("migrateIngestTokensTable", () => {
  let dir5: string;
  let db5: InstanceType<typeof Database>;

  beforeAll(() => {
    dir5 = mkdtempSync(join(tmpdir(), "tt-migrate-it-"));
    db5 = new Database(join(dir5, "test.db"));
    // 模拟旧 schema：bound_instance 列
    db5.exec(`
      CREATE TABLE ingest_tokens (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        api_key_encrypted TEXT NOT NULL,
        bound_instance TEXT,
        enabled INTEGER NOT NULL DEFAULT 1,
        last_used_at TEXT,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO ingest_tokens (name, api_key_encrypted, bound_instance, enabled, last_used_at) VALUES
        ('bing-mbp', 'enc-1', 'bing-mbp', 1, '2026-09-01T10:00:00.000Z'),
        ('other', 'enc-2', NULL, 0, NULL);
    `);
  });

  afterAll(() => {
    db5.close();
    rmSync(dir5, { recursive: true, force: true });
  });

  it("rebuilds to bound_uid, migrates all token rows with bound_uid NULL", () => {
    migrateIngestTokensTable(db5);

    const cols = db5.prepare(`PRAGMA table_info(ingest_tokens)`).all().map((c: any) => c.name);
    expect(cols).toEqual(expect.arrayContaining(["bound_uid"]));
    expect(cols).not.toContain("bound_instance");

    // token 行全量回迁（用户资产不丢弃），bound_uid 全部置 NULL 等待重新 TOFU
    const rows: any[] = db5
      .prepare(`SELECT id, name, api_key_encrypted, bound_uid, enabled, last_used_at FROM ingest_tokens ORDER BY id`)
      .all();
    expect(rows).toEqual([
      { id: 1, name: "bing-mbp", api_key_encrypted: "enc-1", bound_uid: null, enabled: 1, last_used_at: "2026-09-01T10:00:00.000Z" },
      { id: 2, name: "other", api_key_encrypted: "enc-2", bound_uid: null, enabled: 0, last_used_at: null },
    ]);
  });

  it("is idempotent on re-run", () => {
    migrateIngestTokensTable(db5);
    migrateIngestTokensTable(db5);
    // 不重复重建：两张表迁移后行数不变
    const count: any = db5.prepare(`SELECT COUNT(*) AS c FROM ingest_tokens`).get();
    expect(count.c).toBe(2);
  });
});
