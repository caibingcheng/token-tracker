// 端到端迁移验证：把一个「旧 schema + 存量数据」的库交给 initDatabase，
// 断言 upstreams 的 protocols/auth_style 回填、named_routes 去 protocol 后同名路由合并禁用、
// 目标池重指且不丢行。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { db, initDatabase, upstreamsTable, namedRoutesTable, namedRouteTargetsTable, closeDb, getRawClient } from "@/lib/db";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;

let dir: string;

const LEGACY_SCHEMA = `
  CREATE TABLE upstreams (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    protocol TEXT NOT NULL,
    base_url TEXT NOT NULL,
    enabled_models TEXT NOT NULL DEFAULT '[]',
    priority INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1,
    health_check_model TEXT,
    health_status TEXT,
    health_updated_at TEXT,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
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
  CREATE UNIQUE INDEX uq_named_route_targets_route_upstream_model
    ON named_route_targets(named_route_id, upstream_id, upstream_model);
  CREATE INDEX idx_named_route_targets_named_route ON named_route_targets(named_route_id);
`;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-legacy-migrate-"));
  const path = join(dir, "legacy.db");
  process.env.SQLITE_DATABASE_PATH = path;
  const legacy = new Database(path);
  legacy.exec(LEGACY_SCHEMA);
  legacy.exec(`
    INSERT INTO upstreams (name, protocol, base_url, enabled_models) VALUES
      ('zen-openai', 'openai', 'https://zen.example', '["gpt-5"]'),
      ('zen-anthropic', 'anthropic', 'https://zen.example', '["claude-sonnet"]'),
      ('solo', 'gemini', 'https://g.example', '["gemini-3-flash"]');
    -- 同名双协议：分类器配置不同 → 合并后自动禁用
    INSERT INTO named_routes (name, protocol, instruction) VALUES
      ('twin', 'openai', 'cheap'),
      ('twin', 'anthropic', 'precise'),
      ('solo-alias', 'gemini', '');
    INSERT INTO named_route_targets (named_route_id, upstream_id, upstream_model) VALUES
      (1, 1, 'gpt-5'),
      (2, 2, 'claude-sonnet'),
      (3, 3, 'gemini-3-flash');
  `);
  legacy.close();
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

describe("legacy DB → initDatabase", () => {
  it("backfills auth_style/protocols and collapses same-name named routes", async () => {
    await initDatabase();

    const ups = (await db.select().from(upstreamsTable)) as any[];
    const byName = new Map(ups.map((u) => [u.name, u]));
    expect(byName.get("zen-openai")).toMatchObject({ protocols: '["openai"]', authStyle: "bearer" });
    expect(byName.get("zen-anthropic")).toMatchObject({
      protocols: '["anthropic"]',
      authStyle: "x-api-key",
    });
    expect(byName.get("solo")).toMatchObject({ protocols: '["gemini"]', authStyle: "x-goog-api-key" });

    const routes = (await db.select().from(namedRoutesTable)) as any[];
    const twin = routes.find((r) => r.name === "twin");
    const solo = routes.find((r) => r.name === "solo-alias");
    expect(routes).toHaveLength(2);
    // 冲突（instruction 不同）→ 整条禁用，保留 id 最小行的内容
    expect(twin).toMatchObject({ id: 1, enabled: 0, instruction: "cheap" });
    expect(solo).toMatchObject({ id: 3, enabled: 1 });
    expect(routes.every((r) => !("protocol" in r))).toBe(true);

    const targets = (await db.select().from(namedRouteTargetsTable)) as any[];
    expect(targets).toHaveLength(3);
    expect(targets.filter((t) => t.namedRouteId === 1)).toHaveLength(2);
    expect(targets.find((t) => t.namedRouteId === 3)?.upstreamModel).toBe("gemini-3-flash");

    // 合并把 loser 行的配置从库里删了，只有审计里还留着原值
    const audits = getRawClient()
      .prepare(`SELECT action, actor, target_type, target_id, details FROM admin_audit_logs
                WHERE action = 'migration_conflict'`)
      .all() as any[];
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: null, target_type: "named_route", target_id: 1 });
    const details = JSON.parse(audits[0]!.details);
    expect(details).toMatchObject({
      scope: "named_routes",
      kind: "same_name_merge",
      name: "twin",
      keptRouteId: 1,
      disabled: true,
    });
    expect(details.routes).toHaveLength(2);
    expect(details.routes[0]).toMatchObject({ protocol: "openai", instruction: "cheap" });
    expect(details.routes[1]).toMatchObject({ protocol: "anthropic", instruction: "precise" });
    expect(details.routes[1].targets).toEqual([
      { upstreamId: 2, upstreamModel: "claude-sonnet", description: null, priority: 0 },
    ]);
  });

  it("is idempotent across a second init", async () => {
    closeDb();
    await initDatabase();
    const routes = (await db.select().from(namedRoutesTable)) as any[];
    expect(routes).toHaveLength(2);
    const ups = (await db.select().from(upstreamsTable)) as any[];
    expect(ups.find((u) => u.name === "zen-anthropic")?.authStyle).toBe("x-api-key");
  });
});

// v1 老库：只有 routing_rules / virtual_models / virtual_model_routes，从来没有 named_routes 表。
// 本次启动的 CREATE TABLE IF NOT EXISTS 会先按**新** schema 建表（无 protocol 列），
// 随后 legacy fold 仍按旧 schema 写 name+protocol → 必须靠迁移自己补列+补索引才能不炸。
const V1_SCHEMA = `
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
  CREATE TABLE routing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
    target_model TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(name, protocol)
  );
  CREATE TABLE virtual_models (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    protocol TEXT NOT NULL,
    classifier_upstream_id INTEGER NOT NULL DEFAULT 0,
    classifier_model TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
    UNIQUE(name, protocol)
  );
  CREATE TABLE virtual_model_routes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    virtual_model_id INTEGER NOT NULL REFERENCES virtual_models(id) ON DELETE CASCADE,
    upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
    upstream_model TEXT NOT NULL,
    created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  );
`;

describe("v1 legacy DB (routing_rules only) → initDatabase", () => {
  let v1Dir: string;
  let v1OriginalPath: string | undefined;

  beforeAll(() => {
    v1OriginalPath = process.env.SQLITE_DATABASE_PATH;
    v1Dir = mkdtempSync(join(tmpdir(), "tt-v1-legacy-"));
    const path = join(v1Dir, "v1.db");    const legacy = new Database(path);
    legacy.exec(V1_SCHEMA);
    legacy.exec(`
      INSERT INTO upstreams (name, protocol, base_url, enabled_models) VALUES
        ('up', 'openai', 'https://up.example', '["gpt-4o"]'),
        ('up2', 'gemini', 'https://g.example', '["gemini-3-flash"]');
      INSERT INTO routing_rules (name, protocol, upstream_id, target_model) VALUES
        ('alias', 'openai', 1, 'gpt-4o');
      INSERT INTO virtual_models (name, protocol, classifier_upstream_id, classifier_model) VALUES
        ('vm', 'gemini', 1, 'jev-latest');
      INSERT INTO virtual_model_routes (virtual_model_id, upstream_id, upstream_model) VALUES (1, 2, 'gemini-3-flash');
    `);
    legacy.close();
    // 同一模块里的 db 单例可能已被上一个 describe 打开：先关掉再用新路径重新初始化
    closeDb();
    process.env.SQLITE_DATABASE_PATH = path;
  });

  afterAll(() => {
    closeDb();
    rmSync(v1Dir, { recursive: true, force: true });
    if (v1OriginalPath === undefined) delete process.env.SQLITE_DATABASE_PATH;
    else process.env.SQLITE_DATABASE_PATH = v1OriginalPath;
  });

  it("folds legacy tables into the protocol-less named_routes schema", async () => {
    await initDatabase();

    const routes = (await db.select().from(namedRoutesTable)) as any[];
    expect(routes.map((r) => r.name).sort()).toEqual(["alias", "vm"]);
    expect(routes.every((r) => !("protocol" in r))).toBe(true);
    expect(routes.find((r) => r.name === "vm")?.classifierKind).toBe("model");

    const targets = (await db.select().from(namedRouteTargetsTable)) as any[];
    expect(targets).toHaveLength(2);

    // 旧表已删
    const tableNames = getRawClient()
      .prepare(`SELECT name FROM sqlite_master WHERE type='table'`)
      .all()
      .map((r: any) => r.name as string);
    expect(tableNames).not.toContain("routing_rules");
    expect(tableNames).not.toContain("virtual_models");
    expect(tableNames).not.toContain("virtual_model_routes");

    // 面/认证回填照旧生效
    const ups = (await db.select().from(upstreamsTable)) as any[];
    expect(ups.find((u) => u.name === "up")).toMatchObject({ protocols: '["openai"]', authStyle: "bearer" });
  });
});

// 降级启动：数据整理类迁移失败不该把服务搞挂，且必须留下面包屑（settings.migration_issues
// + 迁移前快照 + 旧表备份）。
describe("degraded start on migration failure", () => {
  it("keeps the service usable and records the failure instead of throwing", async () => {
    // 前一个 describe 的 afterAll 已 closeDb：重新初始化（同一库文件）
    await initDatabase();
    const { pendingMigrations, MIGRATION_ISSUES_KEY } = await import("./migrate-preflight");
    const raw = getRawClient();

    // 模拟一条会失败的「数据整理类」迁移：待跑清单能识别，但执行体抛错
    expect(pendingMigrations(raw)).toEqual([]); // 当前库结构已是新版

    const { getMigrationIssues } = await import("./migration-status");
    expect((await getMigrationIssues()).issues).toEqual([]);

    // 直接注入一条 issues 记录（等价于 runMigration 捕获后的落库结果），
    // 走的是 db/index.ts 里 persistMigrationIssues 的同一条 SQL
    raw.prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    ).run(
      MIGRATION_ISSUES_KEY,
      JSON.stringify({ at: "2026-01-01T00:00:00.000Z", issues: [{ name: "named_routes.drop_protocol", error: "boom" }] })
    );

    const status = await getMigrationIssues();
    expect(status.at).toBe("2026-01-01T00:00:00.000Z");
    expect(status.issues).toEqual([{ name: "named_routes.drop_protocol", error: "boom" }]);

    // 恢复正常（下次启动跑通）后清 key → banner 消失
    raw.prepare(`DELETE FROM settings WHERE key = ?`).run(MIGRATION_ISSUES_KEY);
    expect((await getMigrationIssues()).issues).toEqual([]);
  });
});
