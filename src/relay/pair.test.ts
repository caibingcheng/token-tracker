// /pair 页状态展示：有 device token（卷里保留的配对结果）时必须显示 "Paired as …"，
// 而不是 "Pairing…"——后者会让已经在正常转发的 relay 看起来像卡在配对里。
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  // 顺手绑到 env：否则忘记赋值时 loadState 会去读（并覆写）仓库里的 data/relay.state.json
  process.env.RELAY_STATE_PATH = path;
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

  it("pairView 与 /pair/status 同源：已配对时 code 为 null、fingerprint 只给前 8 位", async () => {
    process.env.RELAY_STATE_PATH = writeState({ deviceToken: "dt-abc" });
    const { pairView } = await import("./pair");
    expect(pairView()).toEqual({
      status: "paired",
      pending: false,
      paired: true,
      headline: "Paired as relay",
      code: null,
      deviceName: "relay",
      fingerprint: "u-012345",
      center: "http://127.0.0.1:3001",
      lastPlanOutcome: null,
      errorDetail: null,
    });
  });

  it("页面自带自动刷新脚本，按状态选择频率（配对中 2s / 已配对 15s）", async () => {
    process.env.RELAY_STATE_PATH = writeState({ deviceToken: "dt-abc" });
    const { renderPairPage } = await import("./pair");
    const pairedHtml = renderPairPage();
    expect(pairedHtml).toContain('fetch("/pair/status"');
    expect(pairedHtml).toContain("location.reload()");
    expect(pairedHtml).toContain("setInterval(tick, 15000)");

    vi.resetModules();
    process.env.RELAY_STATE_PATH = writeState({});
    const unpaired = await import("./pair");
    expect(unpaired.renderPairPage()).toContain("setInterval(tick, 2000)");
  });

  it("device token 被中心拒绝 → 清本地 token 并重新进入配对（自愈）", async () => {
    const path = writeState({ deviceToken: "dt-stale", pairedAt: "2026-01-01T00:00:00.000Z" });    // 指到一个必然拒绝连接的端口：不往真实中心发 pair/start，也不会建出待授权记录
    process.env.CENTER_URL = "http://127.0.0.1:1";
    const { currentDeviceToken, pairRuntime, recoverFromRejectedToken } = await import("./pair");
    expect(currentDeviceToken()).toBe("dt-stale");
    await recoverFromRejectedToken("Invalid or revoked device token");
    expect(currentDeviceToken()).toBeNull();
    expect(pairRuntime().status).toBe("failed"); // 连不上中心：startPairing 失败，但 token 已清
    const saved = JSON.parse(readFileSync(path, "utf8")) as { deviceToken: string | null };
    expect(saved.deviceToken).toBeNull();
  });
});
