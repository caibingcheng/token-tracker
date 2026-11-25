import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  migrateUpstreamAuthStyleAndProtocols,
  migrateNamedRoutesDropProtocol,
} from "./migrate";

function withTempDb(fn: (db: InstanceType<typeof Database>) => void): void {
  const dir = mkdtempSync(join(tmpdir(), "tt-migrate-auth-"));
  const db = new Database(join(dir, "test.db"));
  try {
    fn(db);
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
}

const UPSTREAMS_SQL = `
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
`;

describe("migrateUpstreamAuthStyleAndProtocols", () => {
  it("adds protocols/auth_style and backfills from the legacy single protocol", () => {
    withTempDb((db) => {
      db.exec(UPSTREAMS_SQL);
      db.exec(`
        INSERT INTO upstreams (name, protocol, base_url) VALUES
          ('zen', 'openai', 'https://zen.example'),
          ('kimi', 'anthropic', 'https://kimi.example'),
          ('google', 'gemini', 'https://g.example');
      `);

      migrateUpstreamAuthStyleAndProtocols(db);

      const rows = db
        .prepare(`SELECT protocol, protocols, auth_style FROM upstreams ORDER BY id`)
        .all() as any[];
      // 存量行为不变：一条记录只服务它原来那一个面，认证按面推导
      expect(rows[0]).toEqual({ protocol: "openai", protocols: '["openai"]', auth_style: "bearer" });
      expect(rows[1]).toEqual({
        protocol: "anthropic",
        protocols: '["anthropic"]',
        auth_style: "x-api-key",
      });
      expect(rows[2]).toEqual({
        protocol: "gemini",
        protocols: '["gemini"]',
        auth_style: "x-goog-api-key",
      });
    });
  });

  it("repairs garbage values instead of failing (fail-open to the legacy single face)", () => {
    withTempDb((db) => {
      db.exec(UPSTREAMS_SQL);
      db.exec(`INSERT INTO upstreams (name, protocol, base_url) VALUES ('x', 'anthropic', 'https://x.example')`);
      migrateUpstreamAuthStyleAndProtocols(db);
      db.exec(`UPDATE upstreams SET protocols = 'not-json', auth_style = 'basic'`);

      migrateUpstreamAuthStyleAndProtocols(db);

      const row = db.prepare(`SELECT protocols, auth_style FROM upstreams`).get() as any;
      expect(row.protocols).toBe('["anthropic"]');
      expect(row.auth_style).toBe("x-api-key");
    });
  });

  it("is idempotent and keeps explicit multi-face config", () => {
    withTempDb((db) => {
      db.exec(UPSTREAMS_SQL);
      db.exec(`INSERT INTO upstreams (name, protocol, base_url) VALUES ('relay', 'openai', 'https://relay.example')`);
      migrateUpstreamAuthStyleAndProtocols(db);
      // 迁移后写入显式多面配置，再跑一遍不得被回填覆盖
      db.exec(`UPDATE upstreams SET protocols = '["openai","anthropic"]', auth_style = 'bearer'`);
      migrateUpstreamAuthStyleAndProtocols(db);

      const row = db.prepare(`SELECT protocols, auth_style FROM upstreams`).get() as any;
      expect(row.protocols).toBe('["openai","anthropic"]');
      expect(row.auth_style).toBe("bearer");
    });
  });
});

const NAMED_ROUTES_SQL = `
  CREATE TABLE upstreams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL
  );
  INSERT INTO upstreams (name, protocol, base_url) VALUES
    ('up-openai', 'openai', 'https://a.example'),
    ('up-anthropic', 'anthropic', 'https://b.example');
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
  CREATE UNIQUE INDEX uq_named_routes_name_protocol ON named_routes(name, protocol);
  CREATE TABLE named_route_targets (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    named_route_id INTEGER NOT NULL REFERENCES named_routes(id) ON DELETE CASCADE,
    upstream_id INTEGER REFERENCES upstreams(id) ON DELETE CASCADE,
    upstream_model TEXT NOT NULL,
    description TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

describe("migrateNamedRoutesDropProtocol", () => {
  it("drops the protocol column and makes name globally unique", () => {
    withTempDb((db) => {
      db.exec(NAMED_ROUTES_SQL);
      db.exec(`INSERT INTO named_routes (name, protocol) VALUES ('solo', 'openai')`);

      const reports = migrateNamedRoutesDropProtocol(db);

      expect(reports).toHaveLength(0);
      const cols = db
        .prepare(`PRAGMA table_info(named_routes)`)
        .all()
        .map((c: any) => c.name);
      expect(cols).not.toContain("protocol");
      // 唯一索引变成 name 单列
      expect(() =>
        db.exec(`INSERT INTO named_routes (name) VALUES ('solo')`)
      ).toThrow(/UNIQUE/);
    });
  });

  it("merges same-name rows into one pool and keeps the smallest id", () => {
    withTempDb((db) => {
      db.exec(NAMED_ROUTES_SQL);
      db.exec(`
        INSERT INTO named_routes (name, protocol) VALUES ('twin', 'openai');
        INSERT INTO named_routes (name, protocol) VALUES ('twin', 'anthropic');
        INSERT INTO named_route_targets (named_route_id, upstream_id, upstream_model)
          VALUES (1, 1, 'gpt-4o');
        INSERT INTO named_route_targets (named_route_id, upstream_id, upstream_model)
          VALUES (2, 2, 'claude-sonnet');
      `);

      const reports = migrateNamedRoutesDropProtocol(db);

      expect(reports).toHaveLength(1);
      expect(reports[0]).toMatchObject({
        name: "twin",
        keeperId: 1,
        mergedRouteIds: [1, 2],
        disabled: false,
        reasons: [],
      });
      // 合并前的原始行快照留在报告里（loser 行已从表里删除）
      expect(reports[0]!.routes).toMatchObject([
        { id: 1, protocol: "openai", targets: [{ upstreamId: 1, upstreamModel: "gpt-4o" }] },
        { id: 2, protocol: "anthropic", targets: [{ upstreamId: 2, upstreamModel: "claude-sonnet" }] },
      ]);
      const routes = db.prepare(`SELECT id, name, enabled FROM named_routes`).all() as any[];
      expect(routes).toEqual([{ id: 1, name: "twin", enabled: 1 }]);
      const targets = db
        .prepare(`SELECT named_route_id, upstream_id, upstream_model FROM named_route_targets ORDER BY id`)
        .all() as any[];
      expect(targets).toEqual([
        { named_route_id: 1, upstream_id: 1, upstream_model: "gpt-4o" },
        { named_route_id: 1, upstream_id: 2, upstream_model: "claude-sonnet" },
      ]);
    });
  });

  it("disables the merged route when classifier config conflicts (no silent config loss)", () => {
    withTempDb((db) => {
      db.exec(NAMED_ROUTES_SQL);
      db.exec(`
        INSERT INTO named_routes (name, protocol, instruction) VALUES ('mixed', 'openai', 'keep openai');
        INSERT INTO named_routes (name, protocol, instruction) VALUES ('mixed', 'anthropic', 'keep anthropic');
      `);

      const reports = migrateNamedRoutesDropProtocol(db);

      expect(reports).toHaveLength(1);
      expect(reports[0]!.disabled).toBe(true);
      expect(reports[0]!.reasons.join(" ")).toContain("instruction differs");
      const row = db.prepare(`SELECT id, name, enabled, instruction FROM named_routes`).get() as any;
      // 保留 id 最小的行内容，但整条路由禁用，等人工复核
      expect(row).toEqual({ id: 1, name: "mixed", enabled: 0, instruction: "keep openai" });
    });
  });

  it("disables the merged route when both pools contain the same target", () => {
    withTempDb((db) => {
      db.exec(NAMED_ROUTES_SQL);
      db.exec(`
        INSERT INTO named_routes (name, protocol) VALUES ('dup', 'openai');
        INSERT INTO named_routes (name, protocol) VALUES ('dup', 'anthropic');
        INSERT INTO named_route_targets (named_route_id, upstream_id, upstream_model)
          VALUES (1, 1, 'gpt-4o');
        INSERT INTO named_route_targets (named_route_id, upstream_id, upstream_model)
          VALUES (2, 1, 'gpt-4o');
      `);

      const reports = migrateNamedRoutesDropProtocol(db);

      expect(reports[0]!.disabled).toBe(true);
      expect(reports[0]!.reasons.join(" ")).toContain("duplicate target");
      const row = db.prepare(`SELECT enabled FROM named_routes`).get() as any;
      expect(row.enabled).toBe(0);
      const targets = db.prepare(`SELECT COUNT(*) AS c FROM named_route_targets`).get() as any;
      expect(targets.c).toBe(1); // 重复目标去重
    });
  });

  it("keeps targets when they cascade-delete would have wiped them (FK off during rebuild)", () => {
    withTempDb((db) => {
      db.exec(NAMED_ROUTES_SQL);
      db.exec(`
        INSERT INTO named_routes (name, protocol) VALUES ('keep', 'openai');
        INSERT INTO named_routes (name, protocol) VALUES ('keep', 'gemini');
        INSERT INTO named_route_targets (named_route_id, upstream_id, upstream_model)
          VALUES (2, 2, 'claude-sonnet');
      `);

      migrateNamedRoutesDropProtocol(db);

      const targets = db.prepare(`SELECT named_route_id, upstream_model FROM named_route_targets`).all() as any[];
      expect(targets).toEqual([{ named_route_id: 1, upstream_model: "claude-sonnet" }]);
    });
  });

  it("is a no-op on the new schema", () => {
    withTempDb((db) => {
      db.exec(`
        CREATE TABLE named_routes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          name TEXT NOT NULL,
          instruction TEXT NOT NULL DEFAULT '',
          classifier_upstream_id INTEGER NOT NULL DEFAULT 0,
          classifier_model TEXT NOT NULL DEFAULT '',
          classifier_kind TEXT NOT NULL DEFAULT 'priority',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO named_routes (name) VALUES ('already-new');
      `);

      expect(migrateNamedRoutesDropProtocol(db)).toEqual([]);
      const row = db.prepare(`SELECT name FROM named_routes`).get() as any;
      expect(row.name).toBe("already-new");
    });
  });
});

describe("migrate-preflight", async () => {
  const { pendingMigrations, pruneOrphanLegacyRows, snapshotBeforeMigrate, LEGACY_NAMED_ROUTES_BACKUP_TABLE } =
    await import("./migrate-preflight");

  it("reports pending migrations for a legacy schema and none for the new one", () => {
    withTempDb((db) => {
      db.exec(`
        CREATE TABLE upstreams (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE,
          protocol TEXT NOT NULL, base_url TEXT NOT NULL
        );
        CREATE TABLE token_records (
          id INTEGER PRIMARY KEY AUTOINCREMENT, model TEXT NOT NULL,
          provider TEXT NOT NULL, target_model TEXT
        );
        CREATE TABLE named_routes (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, protocol TEXT NOT NULL
        );
      `);
      expect(pendingMigrations(db)).toEqual(
        expect.arrayContaining([
          "upstreams.protocols",
          "upstreams.auth_style",
          "token_records.request_model",
          "token_records.drop_target_model",
          "named_routes.drop_protocol",
        ])
      );
    });
  });

  it("prunes orphan legacy rows that would abort the fold (FK violations bypass OR IGNORE)", () => {
    withTempDb((db) => {
      db.exec(`
        CREATE TABLE upstreams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL);
        INSERT INTO upstreams (name) VALUES ('up');
        CREATE TABLE routing_rules (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, protocol TEXT, upstream_id INTEGER, target_model TEXT
        );
        INSERT INTO routing_rules (name, protocol, upstream_id, target_model) VALUES ('ok', 'openai', 1, 'm');
        INSERT INTO routing_rules (name, protocol, upstream_id, target_model) VALUES ('orphan', 'openai', 99, 'm');
        CREATE TABLE virtual_models (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT);
        INSERT INTO virtual_models (name) VALUES ('vm');
        CREATE TABLE virtual_model_routes (
          id INTEGER PRIMARY KEY AUTOINCREMENT, virtual_model_id INTEGER, upstream_id INTEGER, upstream_model TEXT
        );
        INSERT INTO virtual_model_routes (virtual_model_id, upstream_id, upstream_model) VALUES (1, 1, 'm');
        INSERT INTO virtual_model_routes (virtual_model_id, upstream_id, upstream_model) VALUES (1, 42, 'm');
      `);

      const pruned = pruneOrphanLegacyRows(db);
      expect(pruned).toEqual({ routingRules: 1, virtualModelRoutes: 1 });
      expect((db.prepare(`SELECT name FROM routing_rules`).all() as any[]).map((r) => r.name)).toEqual(["ok"]);
      expect((db.prepare(`SELECT COUNT(*) c FROM virtual_model_routes`).get() as any).c).toBe(1);
    });
  });

  it("writes a consistent pre-migration snapshot file", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-snapshot-"));
    const dbPath = join(dir, "test.db");
    const db = new Database(dbPath);
    try {
      db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('x')`);
      const snap = snapshotBeforeMigrate(db, dbPath);
      expect(snap).toBe(`${dbPath}.pre-migrate`);
      const copy = new Database(snap!);
      expect((copy.prepare(`SELECT v FROM t`).get() as any).v).toBe("x");
      copy.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("does not overwrite an existing snapshot while migrations are still incomplete", () => {
    const dir = mkdtempSync(join(tmpdir(), "tt-snapshot-keep-"));
    const dbPath = join(dir, "test.db");
    const db = new Database(dbPath);
    try {
      db.exec(`CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT); INSERT INTO t (v) VALUES ('first')`);
      const snap = snapshotBeforeMigrate(db, dbPath)!;
      // 模拟「部分迁移已生效」的当前状态
      db.exec(`UPDATE t SET v = 'second'`);

      // 上次迁移未完成 → 保留最早那份快照（回退点不能被替换）
      expect(snapshotBeforeMigrate(db, dbPath, { keepExisting: true })).toBe(snap);
      const kept = new Database(snap);
      expect((kept.prepare(`SELECT v FROM t`).get() as any).v).toBe("first");
      kept.close();

      // 上次已跑通（无遗留 issues）→ 正常刷新快照
      snapshotBeforeMigrate(db, dbPath);
      const refreshed = new Database(snap);
      expect((refreshed.prepare(`SELECT v FROM t`).get() as any).v).toBe("second");
      refreshed.close();
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a pre-merge copy of the old named_routes table", () => {
    withTempDb((db) => {
      db.exec(`
        CREATE TABLE upstreams (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, protocol TEXT NOT NULL, base_url TEXT NOT NULL);
        INSERT INTO upstreams (name, protocol, base_url) VALUES ('up', 'openai', 'https://a.example');
        CREATE TABLE named_routes (
          id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, protocol TEXT NOT NULL,
          instruction TEXT NOT NULL DEFAULT '', classifier_upstream_id INTEGER NOT NULL DEFAULT 0,
          classifier_model TEXT NOT NULL DEFAULT '', classifier_kind TEXT NOT NULL DEFAULT 'priority',
          enabled INTEGER NOT NULL DEFAULT 1,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
        INSERT INTO named_routes (name, protocol, instruction) VALUES ('twin', 'openai', 'cheap');
        INSERT INTO named_routes (name, protocol, instruction) VALUES ('twin', 'anthropic', 'precise');
        CREATE TABLE named_route_targets (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          named_route_id INTEGER NOT NULL REFERENCES named_routes(id) ON DELETE CASCADE,
          upstream_id INTEGER REFERENCES upstreams(id) ON DELETE CASCADE,
          upstream_model TEXT NOT NULL, description TEXT, priority INTEGER NOT NULL DEFAULT 0,
          created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        );
      `);

      migrateNamedRoutesDropProtocol(db);

      // 合并丢掉的 loser 行（含 instruction）仍可从备份表取回
      const backup = db
        .prepare(`SELECT name, protocol, instruction FROM ${LEGACY_NAMED_ROUTES_BACKUP_TABLE} ORDER BY id`)
        .all() as any[];
      expect(backup).toEqual([
        { name: "twin", protocol: "openai", instruction: "cheap" },
        { name: "twin", protocol: "anthropic", instruction: "precise" },
      ]);
      // 主表保持合并结果
      expect((db.prepare(`SELECT COUNT(*) c FROM named_routes`).get() as any).c).toBe(1);
    });
  });
});
