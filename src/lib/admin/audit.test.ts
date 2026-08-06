import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

let dir: string;
let dbPath: string;
let recordAuditLog: typeof import("./audit").recordAuditLog;
let db: any;
let adminAuditLogsTable: any;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tt-audit-"));
  dbPath = join(dir, "audit.db");
  process.env.SQLITE_DATABASE_PATH = dbPath;
  const dbModule = await import("@/lib/db");
  await dbModule.initDatabase();
  db = dbModule.db;
  adminAuditLogsTable = dbModule.adminAuditLogsTable;
  const auditModule = await import("./audit");
  recordAuditLog = auditModule.recordAuditLog;
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

function countLogs(): number {
  return db.select().from(adminAuditLogsTable).all().length;
}

describe("recordAuditLog", () => {
  it("writes an audit record with serialized details", async () => {
    await recordAuditLog({
      action: "upstream_created",
      targetType: "upstream",
      targetId: 7,
      ip: "1.2.3.4",
      userAgent: "test-agent",
      details: { name: "deepseek", protocol: "openai" },
    });

    const rows = db.select().from(adminAuditLogsTable).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].action).toBe("upstream_created");
    expect(rows[0].targetType).toBe("upstream");
    expect(rows[0].targetId).toBe(7);
    expect(rows[0].ip).toBe("1.2.3.4");
    expect(rows[0].userAgent).toBe("test-agent");
    expect(rows[0].details).toBe(JSON.stringify({ name: "deepseek", protocol: "openai" }));
  });

  it("defaults actor to admin and writes null details", async () => {
    await recordAuditLog({ action: "login_success", targetType: "system" });

    const rows = db.select().from(adminAuditLogsTable).all();
    const last = rows[rows.length - 1];
    expect(last.actor).toBe("admin");
    expect(last.details).toBeNull();
    expect(last.targetType).toBe("system");
  });

  it("does not throw when database write fails", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const insertSpy = vi.spyOn(db, "insert").mockImplementation(() => {
      throw new Error("db broken");
    });
    try {
      await expect(
        recordAuditLog({ action: "login_failure", targetType: "system" })
      ).resolves.toBeUndefined();
    } finally {
      insertSpy.mockRestore();
      errorSpy.mockRestore();
    }
  });
});

describe("extractClientInfo", () => {
  it("parses ip from x-forwarded-for first entry", async () => {
    const { extractClientInfo } = await import("./audit");
    const req = new Request("https://example.com", {
      headers: { "x-forwarded-for": "203.0.113.9, 10.0.0.1", "user-agent": "curl/8.0" },
    });
    const info = extractClientInfo(req);
    expect(info.ip).toBe("203.0.113.9");
    expect(info.userAgent).toBe("curl/8.0");
  });

  it("falls back to x-real-ip then unknown", async () => {
    const { extractClientInfo } = await import("./audit");
    const req1 = new Request("https://example.com", { headers: { "x-real-ip": "198.51.100.7" } });
    expect(extractClientInfo(req1).ip).toBe("198.51.100.7");

    const req2 = new Request("https://example.com");
    expect(extractClientInfo(req2).ip).toBe("unknown");
  });

  it("normalizes empty user-agent to null and truncates to 512 chars", async () => {
    const { extractClientInfo } = await import("./audit");
    const req1 = new Request("https://example.com", { headers: { "user-agent": "   " } });
    expect(extractClientInfo(req1).userAgent).toBeNull();

    const longUA = "y".repeat(700);
    const req2 = new Request("https://example.com", { headers: { "user-agent": longUA } });
    expect(extractClientInfo(req2).userAgent).toBe(longUA.slice(0, 512));
  });
});
