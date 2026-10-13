// 存量表不会通过 CREATE TABLE IF NOT EXISTS 补列，
// 通过 PRAGMA table_info 检测缺失列并 ALTER TABLE 添加。
export interface MigrateColumn {
  name: string;
  definition: string;
}

export interface MigrateTable {
  table: string;
  columns: MigrateColumn[];
}

export function migrateColumns(
  client: any,
  tables: MigrateTable[]
): void {
  for (const { table, columns } of tables) {
    const existing: string[] = client
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c: any) => c.name);
    for (const { name, definition } of columns) {
      if (!existing.includes(name)) {
        client.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
    }
  }
}

// token_records 专用一次性迁移：model 列语义改为「发往 upstream 的真实名」，
// 原请求名挪到 request_model，废弃 target_model 列。幂等（PRAGMA 检测驱动）。
export function migrateTokenRecordsModelColumns(client: any): void {
  const existing: string[] = client
    .prepare(`PRAGMA table_info(token_records)`)
    .all()
    .map((c: any) => c.name);

  if (!existing.includes("request_model")) {
    client.exec(`ALTER TABLE token_records ADD COLUMN request_model TEXT`);
    client.exec(`UPDATE token_records SET request_model = model`);
  }

  // 旧 schema 下 target_model 存在：把已路由的真实名回填到 model
  if (existing.includes("target_model")) {
    client.exec(
      `UPDATE token_records SET model = target_model WHERE target_model IS NOT NULL`
    );
    client.exec(`ALTER TABLE token_records DROP COLUMN target_model`);
  }
}

// sync_instances 专用迁移：旧 instance 主键结构（instance TEXT PRIMARY KEY）
// → uid 主键 + instance_name 展示名结构。协议已破坏（旧行 name 无对应 uid），
// 旧行直接丢弃（必然重绑重推）。幂等检测：缺少 uid 列 → 触发重建。
export function migrateSyncInstancesTable(client: any): void {
  const existing: string[] = client
    .prepare(`PRAGMA table_info(sync_instances)`)
    .all()
    .map((c: any) => c.name);
  if (existing.includes("uid")) return;

  client.exec(`DROP TABLE IF EXISTS sync_instances_old`);
  client.exec(`
    ALTER TABLE sync_instances RENAME TO sync_instances_old;
    CREATE TABLE sync_instances (
      uid TEXT PRIMARY KEY,
      instance_name TEXT,
      epoch TEXT NOT NULL,
      last_record_id INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT
    );
    DROP TABLE sync_instances_old;
  `);
}

// ingest_tokens 专用迁移：旧 bound_instance 列 → bound_uid 列。
// token 行全量回迁（ingest token 是用户资产，不可丢弃），仅 bound_uid 置 NULL
// 等待重新 TOFU 绑定。幂等检测：存在 bound_instance 列 → 触发重建。
export function migrateIngestTokensTable(client: any): void {
  const existing: string[] = client
    .prepare(`PRAGMA table_info(ingest_tokens)`)
    .all()
    .map((c: any) => c.name);
  if (!existing.includes("bound_instance")) return;

  client.exec(`DROP TABLE IF EXISTS ingest_tokens_old`);
  client.exec(`
    ALTER TABLE ingest_tokens RENAME TO ingest_tokens_old;
    CREATE TABLE ingest_tokens (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      api_key_encrypted TEXT NOT NULL,
      bound_uid TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      last_used_at TEXT,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO ingest_tokens (id, name, api_key_encrypted, bound_uid, enabled, last_used_at, created_at)
      SELECT id, name, api_key_encrypted, NULL, enabled, last_used_at, created_at FROM ingest_tokens_old;
    DROP TABLE ingest_tokens_old;
  `);
}

// 命名路由迁移（幂等）：把旧 routing_rules / virtual_models + virtual_model_routes 折叠进
// named_routes + named_route_targets，然后删旧表。
// - manual 规则行 → named_routes(classifier_kind='priority') + 各目标一条 target
// - virtual model 行 → 同名同协议 upsert（同名 manual 行的分类器配置被 vm 覆盖）+ 其路由候选进 target
// 旧表不存在（全新库 / 已迁移）直接跳过；旧表缺后加列（priority / description / classifier_kind 等）按默认值回填。
export function migrateNamedRoutesTables(client: any): void {
  const tableNames: string[] = client
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: any) => r.name);
  const hasRoutingRules = tableNames.includes("routing_rules");
  const hasVirtualModels = tableNames.includes("virtual_models");
  if (!hasRoutingRules && !hasVirtualModels) return;

  const columnsOf = (table: string): string[] =>
    client
      .prepare(`PRAGMA table_info(${table})`)
      .all()
      .map((c: any) => c.name);

  // 1. manual 规则（routing_rules）→ priority 规则分类器的命名路由
  if (hasRoutingRules) {
    const ruleColumns = columnsOf("routing_rules");
    const priorityExpr = ruleColumns.includes("priority") ? "priority" : "0";
    client.exec(`
      INSERT OR IGNORE INTO named_routes
        (name, protocol, instruction, classifier_upstream_id, classifier_model, classifier_kind, enabled, created_at)
        SELECT name, protocol, '', 0, '', 'priority', 1, created_at FROM routing_rules;
      INSERT OR IGNORE INTO named_route_targets
        (named_route_id, upstream_id, upstream_model, description, priority, created_at)
        SELECT nr.id, rr.upstream_id, rr.target_model, NULL, ${priorityExpr}, rr.created_at
        FROM routing_rules rr
        JOIN named_routes nr ON nr.name = rr.name AND nr.protocol = rr.protocol;
    `);
  }

  // 2. virtual model 行：同名同协议合并到一个命名路由，分类器配置以 vm 为准
  if (hasVirtualModels) {
    const vmColumns = columnsOf("virtual_models");
    const instructionExpr = vmColumns.includes("instruction") ? "instruction" : "''";
    const kindExpr = vmColumns.includes("classifier_kind") ? "classifier_kind" : "'model'";
    const enabledExpr = vmColumns.includes("enabled") ? "enabled" : "1";
    const classifierUpstreamExpr = vmColumns.includes("classifier_upstream_id")
      ? "classifier_upstream_id"
      : "0";
    const classifierModelExpr = vmColumns.includes("classifier_model") ? "classifier_model" : "''";
    client.exec(`
      INSERT INTO named_routes
        (name, protocol, instruction, classifier_upstream_id, classifier_model, classifier_kind, enabled, created_at)
        SELECT name, protocol, ${instructionExpr}, ${classifierUpstreamExpr}, ${classifierModelExpr}, ${kindExpr}, ${enabledExpr}, created_at
        FROM virtual_models
        WHERE 1
        ON CONFLICT(name, protocol) DO UPDATE SET
          instruction = CASE WHEN excluded.instruction <> '' THEN excluded.instruction ELSE instruction END,
          classifier_upstream_id = excluded.classifier_upstream_id,
          classifier_model = excluded.classifier_model,
          classifier_kind = excluded.classifier_kind,
          enabled = excluded.enabled;
    `);
    if (tableNames.includes("virtual_model_routes")) {
      const routeColumns = columnsOf("virtual_model_routes");
      const descriptionExpr = routeColumns.includes("description") ? "vr.description" : "NULL";
      const routePriorityExpr = routeColumns.includes("priority") ? "vr.priority" : "0";
      client.exec(`
        INSERT OR IGNORE INTO named_route_targets
          (named_route_id, upstream_id, upstream_model, description, priority, created_at)
          SELECT nr.id, vr.upstream_id, vr.upstream_model, ${descriptionExpr}, ${routePriorityExpr}, vr.created_at
          FROM virtual_model_routes vr
          JOIN virtual_models vm ON vm.id = vr.virtual_model_id
          JOIN named_routes nr ON nr.name = vm.name AND nr.protocol = vm.protocol;
      `);
    }
  }

  client.exec(`
    DROP TABLE IF EXISTS virtual_model_routes;
    DROP TABLE IF EXISTS virtual_models;
    DROP TABLE IF EXISTS routing_rules;
  `);
}

// named_route_targets.upstream_id 放宽为可空（NULL = 无 provider 目标，按路由解析）。
// SQLite 无法修改列约束，表重建（rename → 新表 → 回迁 → drop）。
// 幂等检测：PRAGMA table_info 的 notnull 标志（全新库建表即可空，直接跳过）。
export function migrateNamedRouteTargetsNullableUpstream(client: any): void {
  const cols: { name: string; notnull: number }[] = client
    .prepare(`PRAGMA table_info(named_route_targets)`)
    .all();
  if (cols.length === 0) return; // 表不存在（不应发生，CREATE TABLE IF NOT EXISTS 已建）
  if (cols.find((c) => c.name === "upstream_id")?.notnull !== 1) return;

  client.exec(`DROP TABLE IF EXISTS named_route_targets_old`);
  client.exec(`
    ALTER TABLE named_route_targets RENAME TO named_route_targets_old;
    CREATE TABLE named_route_targets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      named_route_id INTEGER NOT NULL REFERENCES named_routes(id) ON DELETE CASCADE,
      upstream_id INTEGER REFERENCES upstreams(id) ON DELETE CASCADE,
      upstream_model TEXT NOT NULL,
      description TEXT,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    );
    INSERT INTO named_route_targets (id, named_route_id, upstream_id, upstream_model, description, priority, created_at)
      SELECT id, named_route_id, upstream_id, upstream_model, description, priority, created_at FROM named_route_targets_old;
    DROP TABLE named_route_targets_old;
    CREATE UNIQUE INDEX IF NOT EXISTS uq_named_route_targets_route_upstream_model
      ON named_route_targets(named_route_id, upstream_id, upstream_model);
    CREATE INDEX IF NOT EXISTS idx_named_route_targets_named_route ON named_route_targets(named_route_id);
  `);
}
