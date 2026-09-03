import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isValidTargetUrl,
  normalizeTargetUrl,
  defaultInstanceName,
  loadSyncConfig,
  saveSyncConfig,
  resetSyncState,
} from "./config";
import { isValidInstanceName, isValidInstanceUid } from "@/lib/ingest/validate";
import { initDatabase } from "@/lib/db";
import { getSetting } from "@/lib/auth/settings";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-synccfg-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
});

beforeEach(async () => {
  await initDatabase();
  await resetSyncState();
  await saveSyncConfig({ targetUrl: "", token: null }).catch(() => {});
});

describe("isValidTargetUrl", () => {
  it("accepts http/https", () => {
    expect(isValidTargetUrl("https://tracker.example.com/ingest/records")).toBe(true);
    expect(isValidTargetUrl("http://192.168.1.10:3000/ingest/records")).toBe(true);
  });
  it("rejects non-http urls and garbage", () => {
    expect(isValidTargetUrl("ftp://example.com")).toBe(false);
    expect(isValidTargetUrl("not-a-url")).toBe(false);
    expect(isValidTargetUrl("")).toBe(false);
  });
});

describe("normalizeTargetUrl", () => {
  it("auto-appends /ingest/records when path is empty or /", () => {
    expect(normalizeTargetUrl("https://tracker.example.com")).toBe(
      "https://tracker.example.com/ingest/records"
    );
    expect(normalizeTargetUrl("https://tracker.example.com/")).toBe(
      "https://tracker.example.com/ingest/records"
    );
  });
  it("keeps an existing path, stripping trailing slashes", () => {
    expect(normalizeTargetUrl("https://a.example.com/ingest/records/")).toBe(
      "https://a.example.com/ingest/records"
    );
    expect(normalizeTargetUrl("http://192.168.1.10:3000/sub/path/")).toBe(
      "http://192.168.1.10:3000/sub/path"
    );
  });
  it("drops query and hash", () => {
    expect(normalizeTargetUrl("https://a.example.com/?x=1#f")).toBe(
      "https://a.example.com/ingest/records"
    );
  });
  it("persists the normalized url via saveSyncConfig", async () => {
    await saveSyncConfig({ targetUrl: "https://a.example.com" });
    expect((await loadSyncConfig()).targetUrl).toBe("https://a.example.com/ingest/records");
  });
});

describe("defaultInstanceName", () => {
  it("produces a valid [a-z0-9-] name", () => {
    const name = defaultInstanceName();
    expect(isValidInstanceName(name)).toBe(true);
    expect(name.length).toBeGreaterThan(0);
  });
});

describe("saveSyncConfig / loadSyncConfig", () => {
  it("round-trips targetUrl and encrypted token; token not exposed in plaintext", async () => {
    await saveSyncConfig({ targetUrl: "https://a.example.com/ingest/records", token: "it-secret" });
    const cfg = await loadSyncConfig();
    expect(cfg.targetUrl).toBe("https://a.example.com/ingest/records");
    expect(cfg.hasToken).toBe(true);
    const stored = await getSetting("sync_token_encrypted");
    expect(stored).not.toContain("it-secret");
  });

  it("clears token when set to null", async () => {
    await saveSyncConfig({ token: "it-secret" });
    expect((await loadSyncConfig()).hasToken).toBe(true);
    await saveSyncConfig({ token: null });
    expect((await loadSyncConfig()).hasToken).toBe(false);
  });

  it("rejects invalid targetUrl and instance", async () => {
    await expect(saveSyncConfig({ targetUrl: "gopher://x" })).rejects.toThrow();
    await expect(saveSyncConfig({ instance: "BAD_NAME" })).rejects.toThrow();
    await expect(saveSyncConfig({ instance: "x".repeat(33) })).rejects.toThrow();
  });

  it("rejects token not starting with it- and trims valid ones", async () => {
    await expect(saveSyncConfig({ token: "not-a-ingest-token" })).rejects.toThrow();
    await expect(saveSyncConfig({ token: "" })).rejects.toThrow();
    await saveSyncConfig({ token: "  it-abc  " });
    const cfg = await loadSyncConfig();
    expect(cfg.hasToken).toBe(true);
  });

  it("persists cursor and droppedCount; resetSyncState zeroes them but keeps uid", async () => {
    const { setSetting } = await import("@/lib/auth/settings");
    await setSetting("sync_cursor", "42");
    await setSetting("sync_dropped_count", "7");
    const cfg = await loadSyncConfig();
    expect(cfg.cursor).toBe(42);
    expect(cfg.droppedCount).toBe(7);
    const uidBefore = cfg.uid;
    expect(isValidInstanceUid(uidBefore)).toBe(true);
    await resetSyncState();
    const after = await loadSyncConfig();
    expect(after.cursor).toBe(0);
    expect(after.droppedCount).toBe(7); // 历史丢弃计数保留（可观测性）
    expect(after.boundUid).toBeNull();
    // uid 是稳定身份键：reset 不重置
    expect(after.uid).toBe(uidBefore);
  });

  it("generates instance, uid and epoch automatically on first use", async () => {
    const { deleteSetting } = await import("@/lib/auth/settings");
    await deleteSetting("sync_instance").catch(() => {});
    await deleteSetting("sync_instance_uid").catch(() => {});
    await deleteSetting("sync_epoch").catch(() => {});
    const cfg = await loadSyncConfig();
    expect(isValidInstanceName(cfg.instance)).toBe(true);
    expect(isValidInstanceUid(cfg.uid)).toBe(true);
    expect(cfg.uid.startsWith("u-")).toBe(true);
    expect(cfg.epoch.length).toBeGreaterThan(0);
    // 持久化，再次读取一致
    const cfg2 = await loadSyncConfig();
    expect(cfg2.instance).toBe(cfg.instance);
    expect(cfg2.uid).toBe(cfg.uid);
    expect(cfg2.epoch).toBe(cfg.epoch);
  });
});