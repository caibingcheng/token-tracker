// /pair 页状态展示：有 device token（卷里保留的配对结果）时必须显示 "Paired as …"，
// 而不是 "Pairing…"——后者会让已经在正常转发的 relay 看起来像卡在配对里。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ORIG = {
  statePath: process.env.RELAY_STATE_PATH,
  centerUrl: process.env.CENTER_URL,
  deviceName: process.env.RELAY_DEVICE_NAME,
};

let dir: string;

function writeState(state: Record<string, unknown>): string {
  dir = mkdtempSync(join(tmpdir(), "tt-relay-pair-"));
  const path = join(dir, "relay.state.json");
  writeFileSync(
    path,
    JSON.stringify({
      fingerprint: "u-0123456789abcdef0123456789abcdef",
      publicKey: "pub",
      privateKeyPem: "-----BEGIN PRIVATE KEY-----\nfake\n-----END PRIVATE KEY-----",
      deviceToken: null,
      pairedAt: null,
      centerUrlHash: null,
      ...state,
    })
  );
  return path;
}

beforeEach(() => {
  process.env.CENTER_URL = "http://127.0.0.1:3001";
  delete process.env.RELAY_DEVICE_NAME;
  vi.resetModules();
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG.statePath === undefined) delete process.env.RELAY_STATE_PATH;
  else process.env.RELAY_STATE_PATH = ORIG.statePath;
  if (ORIG.centerUrl === undefined) delete process.env.CENTER_URL;
  else process.env.CENTER_URL = ORIG.centerUrl;
  if (ORIG.deviceName === undefined) delete process.env.RELAY_DEVICE_NAME;
  else process.env.RELAY_DEVICE_NAME = ORIG.deviceName;
});

describe("relay /pair 页状态", () => {
  it("已配对（state 里有 token）→ Paired as，而不是 Pairing…", async () => {
    process.env.RELAY_STATE_PATH = writeState({ deviceToken: "dt-abc", pairedAt: "2026-01-01T00:00:00.000Z" });
    const { pairRuntime, renderPairPage } = await import("./pair");
    expect(pairRuntime().status).toBe("paired");
    const html = renderPairPage();
    expect(html).toContain("Paired as relay");
    expect(html).not.toContain(">Pairing…<");
  });

  it("未配对且还没拿到码 → Pairing…", async () => {
    process.env.RELAY_STATE_PATH = writeState({});
    const { pairRuntime, renderPairPage } = await import("./pair");
    expect(pairRuntime().status).toBe("pairing");
    expect(renderPairPage()).toContain("Pairing…");
  });

  it("设备名取 RELAY_DEVICE_NAME，且 HTML 转义", async () => {
    process.env.RELAY_STATE_PATH = writeState({ deviceToken: "dt-abc" });
    process.env.RELAY_DEVICE_NAME = "edge-<a>";
    const { renderPairPage } = await import("./pair");
    expect(renderPairPage()).toContain("Paired as edge-&lt;a&gt;");
  });
});
