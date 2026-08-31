import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  isValidModelsDevSource,
  parseModelsDevSource,
  loadModelsDevSource,
  setModelsDevSource,
  MODELS_DEV_SOURCE_SETTING_KEY,
} from "./settings-models-dev-source";
import { deleteSetting, setSetting } from "@/lib/auth/settings";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-settings-mdsrc-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
  await deleteSetting(MODELS_DEV_SOURCE_SETTING_KEY).catch(() => {});
});

describe("isValidModelsDevSource / parseModelsDevSource", () => {
  it("accepts both source values only", () => {
    expect(isValidModelsDevSource("models.dev")).toBe(true);
    expect(isValidModelsDevSource("github")).toBe(true);
    expect(isValidModelsDevSource("litellm")).toBe(false);
    expect(isValidModelsDevSource("models-dev")).toBe(false);
    expect(isValidModelsDevSource(null)).toBe(false);
    expect(isValidModelsDevSource(undefined)).toBe(false);
    expect(isValidModelsDevSource(42)).toBe(false);
  });

  it("parse falls back to default for null / invalid", () => {
    expect(parseModelsDevSource(null)).toBe("models.dev");
    expect(parseModelsDevSource("unknown")).toBe("models.dev");
    expect(parseModelsDevSource("github")).toBe("github");
    expect(parseModelsDevSource("models.dev")).toBe("models.dev");
  });
});

describe("loadModelsDevSource / setModelsDevSource", () => {
  it("defaults to models.dev when unset", async () => {
    expect(await loadModelsDevSource()).toBe("models.dev");
  });

  it("round-trips both values with immediate visibility (withSkipCache)", async () => {
    await setModelsDevSource("github");
    expect(await loadModelsDevSource()).toBe("github");
    await setModelsDevSource("models.dev");
    expect(await loadModelsDevSource()).toBe("models.dev");
  });

  it("falls back to default for corrupt stored value", async () => {
    await setSetting(MODELS_DEV_SOURCE_SETTING_KEY, "oops");
    expect(await loadModelsDevSource()).toBe("models.dev");
  });
});
