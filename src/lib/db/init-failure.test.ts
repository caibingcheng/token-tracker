// 环境级初始化失败（库打不开/不可写）的行为：
//   - 抛 DatabaseUnavailableError（上层 server.onError 据此返回 503 + 可执行提示，而非裸 500）
//   - 写一份 <db>.migration-error 供运维排查
//   - initPromise 复位，下次调用会重试（不是永久卡死）
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { closeDb, initDatabase } from "@/lib/db";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;

let dir: string;
let dbPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-init-failure-"));
  // 指向一个目录而不是文件：better-sqlite3 打开必失败（模拟只读/损坏/权限问题）
  dbPath = join(dir, "as-directory");
  mkdirSync(dbPath);
  process.env.SQLITE_DATABASE_PATH = dbPath;
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

describe("initDatabase on an unopenable database", () => {
  it("throws DatabaseUnavailableError with an actionable message", async () => {
    await expect(initDatabase()).rejects.toMatchObject({ name: "DatabaseUnavailableError" });
    try {
      await initDatabase();
    } catch (err) {
      const message = (err as Error).message;
      expect(message).toContain("Database schema initialization failed");
      expect(message).toContain("pre-migration snapshot");
    }
  });

  it("writes a *.migration-error breadcrumb next to the database", () => {
    const errFile = `${dbPath}.migration-error`;
    expect(existsSync(errFile)).toBe(true);
    const parsed = JSON.parse(readFileSync(errFile, "utf-8"));
    expect(typeof parsed.at).toBe("string");
    expect(parsed.error.length).toBeGreaterThan(0);
  });

  it("retries on the next call instead of caching the failure", async () => {
    // 第二次仍失败（环境没变），但能再次走到打开/迁移逻辑 → 说明 initPromise 已复位
    await expect(initDatabase()).rejects.toMatchObject({ name: "DatabaseUnavailableError" });
  });
});
