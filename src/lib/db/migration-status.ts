// 迁移降级启动的状态出口（settings.migration_issues）。
// 由 db/index.ts 在 initDatabase 末尾写入；正常跑通会删掉该 key。
import { eq } from "drizzle-orm";
import { db, initDatabase, settingsTable } from "@/lib/db";
import { MIGRATION_ISSUES_KEY } from "./migrate-preflight";

export interface MigrationIssueInfo {
  name: string;
  error: string;
}

export interface MigrationStatus {
  at: string | null;
  issues: MigrationIssueInfo[];
}

const EMPTY: MigrationStatus = { at: null, issues: [] };

export async function getMigrationIssues(): Promise<MigrationStatus> {
  await initDatabase();
  const row = (await db.select().from(settingsTable).where(eq(settingsTable.key, MIGRATION_ISSUES_KEY)))[0];
  if (!row) return EMPTY;
  try {
    const parsed = JSON.parse(row.value) as Partial<MigrationStatus>;
    const issues = Array.isArray(parsed.issues)
      ? parsed.issues.filter(
          (i): i is MigrationIssueInfo =>
            typeof i === "object" && i !== null && typeof (i as any).name === "string" &&
            typeof (i as any).error === "string"
        )
      : [];
    return { at: typeof parsed.at === "string" ? parsed.at : null, issues };
  } catch {
    return EMPTY;
  }
}
