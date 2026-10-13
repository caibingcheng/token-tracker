import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { migrateColumns, migrateTokenRecordsModelColumns, migrateNamedRoutesTables, migrateNamedRouteTargetsNullableUpstream, migrateSyncInstancesTable, migrateIngestTokensTable } from "./migrate";
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
      { name: "session_id", definition: "session_id TEXT" },
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
      { name: "classifier_models", definition: "classifier_models TEXT" },
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
      expect.arrayContaining(["status", "latency_ms", "ttft_ms", "virtual_key_id", "user_agent", "session_id", "remote_instance_uid"])
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
      expect.arrayContaining(["balance", "balance_updated_at", "classifier_models"])
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
      .prepare(`SELECT latency_ms, ttft_ms, session_id, remote_instance_uid FROM token_records WHERE model = 'gpt-4o'`)
      .get();
    expect(row.latency_ms).toBe(1234);
    expect(row.ttft_ms).toBeNull();
    expect(row.session_id).toBeNull(); // 存量行不回填
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

describe("migrateNamedRoutesTables", () => {
  function createBaseTables(db: InstanceType<typeof Database>) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS upstreams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL UNIQUE,
        protocol TEXT NOT NULL,
        base_url TEXT NOT NULL,
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1
      );
      CREATE TABLE IF NOT EXISTS named_routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        classifier_upstream_id INTEGER NOT NULL DEFAULT 0,
        classifier_model TEXT NOT NULL DEFAULT '',
        classifier_kind TEXT NOT NULL DEFAULT 'priority',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_named_routes_name_protocol ON named_routes(name, protocol);
      CREATE TABLE IF NOT EXISTS named_route_targets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        named_route_id INTEGER NOT NULL REFERENCES named_routes(id) ON DELETE CASCADE,
        upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
        upstream_model TEXT NOT NULL,
        description TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      CREATE UNIQUE INDEX IF NOT EXISTS uq_named_route_targets_route_upstream_model
        ON named_route_targets(named_route_id, upstream_id, upstream_model);
      INSERT INTO upstreams (name, protocol, base_url) VALUES
        ('up-a', 'openai', 'https://a.example'),
        ('up-b', 'openai', 'https://b.example'),
        ('typesafe', 'openai', 'https://api.typesafe.ai');
    `);
  }

  function withTempDb(
    legacySql: string,
    fn: (db: InstanceType<typeof Database>) => void
  ) {
    const dir = mkdtempSync(join(tmpdir(), "tt-migrate-nr-"));
    const db = new Database(join(dir, "test.db"));
    createBaseTables(db);
    db.exec(legacySql);
    try {
      fn(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const legacyRoutingRules = `
    CREATE TABLE routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL,
      upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
      target_model TEXT NOT NULL,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(name, protocol)
    );
  `;

  it("folds legacy routing_rules into a priority-classifier named route", () => {
    withTempDb(
      `${legacyRoutingRules}
       INSERT INTO routing_rules (name, protocol, upstream_id, target_model) VALUES
         ('my-alias', 'openai', 1, 'gpt-4o-real'),
         ('other-alias', 'openai', 2, 'deepseek-chat');`,
      (db) => {
        migrateNamedRoutesTables(db);

        const routes: any[] = db
          .prepare(`SELECT name, classifier_kind, classifier_upstream_id, classifier_model, enabled FROM named_routes ORDER BY name`)
          .all();
        expect(routes).toEqual([
          { name: "my-alias", classifier_kind: "priority", classifier_upstream_id: 0, classifier_model: "", enabled: 1 },
          { name: "other-alias", classifier_kind: "priority", classifier_upstream_id: 0, classifier_model: "", enabled: 1 },
        ]);

        const targets: any[] = db
          .prepare(
            `SELECT r.name, t.upstream_id, t.upstream_model, t.priority FROM named_route_targets t JOIN named_routes r ON r.id = t.named_route_id ORDER BY r.name`
          )
          .all();
        expect(targets).toEqual([
          { name: "my-alias", upstream_id: 1, upstream_model: "gpt-4o-real", priority: 0 },
          { name: "other-alias", upstream_id: 2, upstream_model: "deepseek-chat", priority: 0 },
        ]);

        // 旧表已删除
        const tables: string[] = db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
          .all()
          .map((r: any) => r.name);
        expect(tables).not.toContain("routing_rules");

        // 幂等：再跑不报错、不重复写入
        migrateNamedRoutesTables(db);
        expect((db.prepare(`SELECT COUNT(*) AS c FROM named_routes`).get() as any).c).toBe(2);
        expect((db.prepare(`SELECT COUNT(*) AS c FROM named_route_targets`).get() as any).c).toBe(2);
      }
    );
  });

  it("keeps rule priorities and merges same-name rules into one route", () => {
    withTempDb(
      `CREATE TABLE routing_rules (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         protocol TEXT NOT NULL,
         upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
         target_model TEXT NOT NULL,
         priority INTEGER NOT NULL DEFAULT 0,
         created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
       );
       INSERT INTO routing_rules (name, protocol, upstream_id, target_model, priority) VALUES
         ('my-alias', 'openai', 1, 'gpt-4o-real', 2),
         ('my-alias', 'openai', 2, 'gpt-4o-alt', 1);`,
      (db) => {
        migrateNamedRoutesTables(db);

        expect((db.prepare(`SELECT COUNT(*) AS c FROM named_routes`).get() as any).c).toBe(1);
        const targets: any[] = db
          .prepare(`SELECT upstream_model, priority FROM named_route_targets ORDER BY priority`)
          .all();
        expect(targets).toEqual([
          { upstream_model: "gpt-4o-alt", priority: 1 },
          { upstream_model: "gpt-4o-real", priority: 2 },
        ]);
      }
    );
  });

  it("folds virtual_models + virtual_model_routes preserving classifier and target metadata", () => {
    withTempDb(
      `CREATE TABLE virtual_models (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         protocol TEXT NOT NULL,
         instruction TEXT NOT NULL DEFAULT '',
         classifier_upstream_id INTEGER NOT NULL,
         classifier_model TEXT NOT NULL,
         classifier_kind TEXT NOT NULL DEFAULT 'model',
         priority INTEGER NOT NULL DEFAULT 0,
         enabled INTEGER NOT NULL DEFAULT 1,
         created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         UNIQUE(name, protocol)
       );
       CREATE TABLE virtual_model_routes (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         virtual_model_id INTEGER NOT NULL REFERENCES virtual_models(id) ON DELETE CASCADE,
         upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
         upstream_model TEXT NOT NULL,
         description TEXT,
         priority INTEGER NOT NULL DEFAULT 0,
         created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         UNIQUE(virtual_model_id, upstream_id, upstream_model)
       );
       INSERT INTO virtual_models (name, protocol, instruction, classifier_upstream_id, classifier_model, classifier_kind, enabled)
         VALUES ('cheap', 'openai', 'pick the cheapest', 3, 'jev-latest', 'model', 0);
       INSERT INTO virtual_model_routes (virtual_model_id, upstream_id, upstream_model, description, priority)
         VALUES (1, 1, 'gpt-4o-mini', 'cheap tier', 1), (1, 2, 'gpt-5', 'complex tier', 0);`,
      (db) => {
        migrateNamedRoutesTables(db);

        const route: any = db
          .prepare(`SELECT name, instruction, classifier_upstream_id, classifier_model, classifier_kind, enabled FROM named_routes`)
          .get();
        expect(route).toEqual({
          name: "cheap",
          instruction: "pick the cheapest",
          classifier_upstream_id: 3,
          classifier_model: "jev-latest",
          classifier_kind: "model",
          enabled: 0,
        });

        const targets: any[] = db
          .prepare(`SELECT upstream_id, upstream_model, description, priority FROM named_route_targets ORDER BY priority`)
          .all();
        expect(targets).toEqual([
          { upstream_id: 2, upstream_model: "gpt-5", description: "complex tier", priority: 0 },
          { upstream_id: 1, upstream_model: "gpt-4o-mini", description: "cheap tier", priority: 1 },
        ]);

        const tables: string[] = db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
          .all()
          .map((r: any) => r.name);
        expect(tables).not.toContain("virtual_models");
        expect(tables).not.toContain("virtual_model_routes");
      }
    );
  });

  it("merges a same-name manual rule and virtual model into one route (virtual classifier wins)", () => {
    withTempDb(
      `${legacyRoutingRules}
       CREATE TABLE virtual_models (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         protocol TEXT NOT NULL,
         instruction TEXT NOT NULL DEFAULT '',
         classifier_upstream_id INTEGER NOT NULL,
         classifier_model TEXT NOT NULL,
         classifier_kind TEXT NOT NULL DEFAULT 'model',
         priority INTEGER NOT NULL DEFAULT 0,
         enabled INTEGER NOT NULL DEFAULT 1,
         created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         UNIQUE(name, protocol)
       );
       CREATE TABLE virtual_model_routes (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         virtual_model_id INTEGER NOT NULL REFERENCES virtual_models(id) ON DELETE CASCADE,
         upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
         upstream_model TEXT NOT NULL,
         description TEXT,
         priority INTEGER NOT NULL DEFAULT 0,
         created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
         UNIQUE(virtual_model_id, upstream_id, upstream_model)
       );
       INSERT INTO routing_rules (name, protocol, upstream_id, target_model) VALUES ('auto', 'openai', 2, 'claude-sonnet');
       INSERT INTO virtual_models (name, protocol, instruction, classifier_upstream_id, classifier_model, classifier_kind)
         VALUES ('auto', 'openai', 'decide by complexity', 3, 'jev-latest', 'model');
       INSERT INTO virtual_model_routes (virtual_model_id, upstream_id, upstream_model, description, priority)
         VALUES (1, 1, 'gpt-4o-mini', 'cheap tier', 0);`,
      (db) => {
        migrateNamedRoutesTables(db);

        expect((db.prepare(`SELECT COUNT(*) AS c FROM named_routes`).get() as any).c).toBe(1);
        const route: any = db
          .prepare(`SELECT instruction, classifier_kind, classifier_model FROM named_routes`)
          .get();
        expect(route).toEqual({
          instruction: "decide by complexity",
          classifier_kind: "model",
          classifier_model: "jev-latest",
        });

        const models: string[] = db
          .prepare(`SELECT upstream_model FROM named_route_targets ORDER BY upstream_model`)
          .all()
          .map((r: any) => r.upstream_model);
        expect(models).toEqual(["claude-sonnet", "gpt-4o-mini"]);
      }
    );
  });
});

describe("migrateNamedRouteTargetsNullableUpstream", () => {
  function withTempDb(
    targetSql: string,
    fn: (db: InstanceType<typeof Database>) => void
  ) {
    const dir = mkdtempSync(join(tmpdir(), "tt-migrate-nrt-"));
    const db = new Database(join(dir, "test.db"));
    db.exec(`
      CREATE TABLE upstreams (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        base_url TEXT NOT NULL
      );
      INSERT INTO upstreams (name, protocol, base_url) VALUES ('up-a', 'openai', 'https://a.example');
      CREATE TABLE named_routes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        protocol TEXT NOT NULL,
        instruction TEXT NOT NULL DEFAULT '',
        classifier_upstream_id INTEGER NOT NULL DEFAULT 0,
        classifier_model TEXT NOT NULL DEFAULT '',
        classifier_kind TEXT NOT NULL DEFAULT 'priority',
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      );
      INSERT INTO named_routes (name, protocol) VALUES ('r', 'openai');
    `);
    db.exec(targetSql);
    try {
      fn(db);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const notNullTable = `
    CREATE TABLE named_route_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      named_route_id INTEGER NOT NULL REFERENCES named_routes(id) ON DELETE CASCADE,
      upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
      upstream_model TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO named_route_targets (named_route_id, upstream_id, upstream_model, description, priority)
      VALUES (1, 1, 'gpt-4o-mini', 'cheap', 2);
  `;

  it("rebuilds a NOT NULL upstream_id table into nullable, preserving rows", () => {
    withTempDb(notNullTable, (db) => {
      migrateNamedRouteTargetsNullableUpstream(db);

      const notnull = (db
        .prepare(`PRAGMA table_info(named_route_targets)`)
        .all() as any[]).find((c) => c.name === "upstream_id").notnull;
      expect(notnull).toBe(0);

      const row: any = db
        .prepare(`SELECT named_route_id, upstream_id, upstream_model, description, priority FROM named_route_targets`)
        .get();
      expect(row).toEqual({
        named_route_id: 1,
        upstream_id: 1,
        upstream_model: "gpt-4o-mini",
        description: "cheap",
        priority: 2,
      });

      // 可空生效：auto 目标（upstream_id NULL）可写入
      db.prepare(
        `INSERT INTO named_route_targets (named_route_id, upstream_id, upstream_model) VALUES (1, NULL, 'claude-sonnet')`
      ).run();
      expect(
        (db.prepare(`SELECT COUNT(*) AS c FROM named_route_targets WHERE upstream_id IS NULL`).get() as any).c
      ).toBe(1);

      // 幂等：二次调用不再重建（rowid 保留）
      migrateNamedRouteTargetsNullableUpstream(db);
      expect((db.prepare(`SELECT COUNT(*) AS c FROM named_route_targets`).get() as any).c).toBe(2);
    });
  });

  it("is a no-op when upstream_id is already nullable", () => {
    withTempDb(
      notNullTable.replace(/INTEGER NOT NULL REFERENCES upstreams\(id\)/, "INTEGER REFERENCES upstreams(id)"),
      (db) => {
        const before: any = db.prepare(`SELECT * FROM named_route_targets`).get();
        migrateNamedRouteTargetsNullableUpstream(db);
        const after: any = db.prepare(`SELECT * FROM named_route_targets`).get();
        expect(after).toEqual(before);
      }
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
