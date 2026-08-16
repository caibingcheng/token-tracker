import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  TOTP_FAIL_THRESHOLD,
  TOTP_BASE_LOCK_MS,
  getTotpFailCount,
  getTotpLockedUntil,
  isTotpLocked,
  recordTotpFailure,
  clearTotpFailures,
} from "@/lib/auth/totp-lock";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-totp-lock-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
  await clearTotpFailures().catch(() => {});
});

describe("totp lockout", () => {
  it("accumulates failures below threshold without locking", async () => {
    for (let i = 0; i < TOTP_FAIL_THRESHOLD - 1; i++) {
      const { lockedUntil } = await recordTotpFailure();
      expect(lockedUntil).toBeNull();
    }
    expect(await getTotpFailCount()).toBe(TOTP_FAIL_THRESHOLD - 1);
    expect(await isTotpLocked()).toBeNull();
  });

  it("locks for base duration when threshold reached", async () => {
    vi.setSystemTime(1_000_000_000_000);
    vi.useFakeTimers();
    try {
      let lockedUntil: number | null = null;
      for (let i = 0; i < TOTP_FAIL_THRESHOLD; i++) {
        const r = await recordTotpFailure();
        lockedUntil = r.lockedUntil;
      }
      expect(lockedUntil).toBe(1_000_000_000_000 + TOTP_BASE_LOCK_MS);
      expect(await isTotpLocked()).toBe(lockedUntil);
    } finally {
      vi.useRealTimers();
    }
  });

  it("doubles lock duration on subsequent thresholds", async () => {
    vi.setSystemTime(1_000_000_000_000);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < TOTP_FAIL_THRESHOLD * 2; i++) {
        await recordTotpFailure();
      }
      const until = await getTotpLockedUntil();
      expect(until).toBe(1_000_000_000_000 + TOTP_BASE_LOCK_MS * 2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("expired lock reports unlocked but keeps count", async () => {
    vi.setSystemTime(1_000_000_000_000);
    vi.useFakeTimers();
    try {
      for (let i = 0; i < TOTP_FAIL_THRESHOLD; i++) {
        await recordTotpFailure();
      }
      expect(await isTotpLocked()).not.toBeNull();
      vi.setSystemTime(1_000_000_000_000 + TOTP_BASE_LOCK_MS + 1000);
      expect(await isTotpLocked()).toBeNull();
      expect(await getTotpFailCount()).toBe(TOTP_FAIL_THRESHOLD);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clear resets count and lock", async () => {
    for (let i = 0; i < TOTP_FAIL_THRESHOLD; i++) {
      await recordTotpFailure();
    }
    expect(await getTotpFailCount()).toBe(TOTP_FAIL_THRESHOLD);
    await clearTotpFailures();
    expect(await getTotpFailCount()).toBe(0);
    expect(await getTotpLockedUntil()).toBeNull();
  });
});
