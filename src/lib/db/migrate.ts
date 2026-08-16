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
