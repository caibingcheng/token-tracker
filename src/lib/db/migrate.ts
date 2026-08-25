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

// routing_rules 专用迁移：部分旧库仍为 UNIQUE(name, protocol)（单目标）结构，
// 需重建表支持多目标（UNIQUE(name, protocol, upstream_id)）+ priority 列。
// SQLite 无法修改表约束，采用表重建：先检测 priority 列是否已存在（幂等），
// 存在即跳过；否则 RENAME → 建新表 → 回迁（priority 回填 0）→ DROP 旧表。
// routing_rules 为管理面小表，重建零风险。旧约束是新约束的超集，回迁必定不冲突。
export function migrateRoutingRulesTable(client: any): void {
  const existing: string[] = client
    .prepare(`PRAGMA table_info(routing_rules)`)
    .all()
    .map((c: any) => c.name);
  if (existing.includes("priority")) return;

  client.exec(`DROP TABLE IF EXISTS routing_rules_old`);
  client.exec(`
    ALTER TABLE routing_rules RENAME TO routing_rules_old;
    CREATE TABLE routing_rules (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      protocol TEXT NOT NULL,
      upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
      target_model TEXT NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
      UNIQUE(name, protocol, upstream_id)
    );
    INSERT INTO routing_rules (id, name, protocol, upstream_id, target_model, priority, created_at)
      SELECT id, name, protocol, upstream_id, target_model, 0, created_at FROM routing_rules_old;
    DROP TABLE routing_rules_old;
    CREATE INDEX IF NOT EXISTS idx_routing_rules_protocol_name ON routing_rules(protocol, name);
  `);
}
