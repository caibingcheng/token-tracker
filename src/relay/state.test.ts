import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "path";
import {
  displayDeviceName,
  getCenterDeviceName,
  resolveRelayStatePath,
  setCenterDeviceName,
} from "./state";

// state 路径解析：env > 存量旧默认（Docker 卷/dev 兼容）> OS 配置目录（CLI）。
// legacy 探测用注入的谓词，测试不碰真实文件系统。
describe("resolveRelayStatePath", () => {
  const noEnv = {};
  it("RELAY_STATE_PATH 最高优先（含空串视为未设置）", () => {
    expect(resolveRelayStatePath("/custom/x.json", () => true, noEnv)).toBe("/custom/x.json");
    expect(resolveRelayStatePath("/custom/x.json", () => false, noEnv)).toBe("/custom/x.json");
    expect(resolveRelayStatePath("  ", () => true, noEnv)).toBe("./data/relay.state.json");
  });

  it("旧默认路径已存在 → 继续用（Docker 卷里的配对凭据不丢）", () => {
    expect(resolveRelayStatePath(undefined, () => true, noEnv)).toBe("./data/relay.state.json");
  });

  it("旧路径不存在 → 回到 OS 配置目录（不跟 cwd 走）", () => {
    expect(resolveRelayStatePath(undefined, () => false, { HOME: "/home/u" })).toBe(
      join("/home/u", ".config", "token-tracker-relay", "relay.state.json")
    );
    expect(
      resolveRelayStatePath(undefined, () => false, { APPDATA: "C:\\Users\\u\\AppData\\Roaming" })
    ).toBe(join("C:\\Users\\u\\AppData\\Roaming", "token-tracker-relay", "relay.state.json"));
    // USERPROFILE（Windows 常见）也可作为 HOME 兜底
    expect(resolveRelayStatePath(undefined, () => false, { USERPROFILE: "C:\\Users\\u" })).toBe(
      join("C:\\Users\\u", ".config", "token-tracker-relay", "relay.state.json")
    );
  });

  it("homedir 不可得 → 回退旧默认目录", () => {
    expect(resolveRelayStatePath(undefined, () => false, { APPDATA: undefined, HOME: undefined })).toBe(
      join("./data", "relay.state.json")
    );
  });
});

// 设备名三源优先级：中心下发（权威）> RELAY_DEVICE_NAME（配对时的默认值）> "relay"。
// 中心的改名靠 plan 响应下发，所以 relay 端只存内存：这里钉住优先级与空值归一化。
describe("relay 展示用设备名", () => {
  const original = process.env.RELAY_DEVICE_NAME;

  beforeEach(() => {
    delete process.env.RELAY_DEVICE_NAME;
    setCenterDeviceName(null);
  });

  afterEach(() => {
    if (original === undefined) delete process.env.RELAY_DEVICE_NAME;
    else process.env.RELAY_DEVICE_NAME = original;
    setCenterDeviceName(null);
  });

  it("两者都缺失时回退 relay", () => {
    expect(getCenterDeviceName()).toBeNull();
    expect(displayDeviceName()).toBe("relay");
  });

  it("只有 RELAY_DEVICE_NAME 时用它（trim，空串视为未设置）", () => {
    process.env.RELAY_DEVICE_NAME = "  edge-a  ";
    expect(displayDeviceName()).toBe("edge-a");
    process.env.RELAY_DEVICE_NAME = "   ";
    expect(displayDeviceName()).toBe("relay");
  });

  it("中心下发优先于本地 env（中心的改名要能覆盖默认名）", () => {
    process.env.RELAY_DEVICE_NAME = "edge-a";
    setCenterDeviceName("renamed-on-center");
    expect(getCenterDeviceName()).toBe("renamed-on-center");
    expect(displayDeviceName()).toBe("renamed-on-center");
  });

  it("中心下发空值等于未下发，回落到 env", () => {
    process.env.RELAY_DEVICE_NAME = "edge-a";
    setCenterDeviceName("   ");
    expect(getCenterDeviceName()).toBeNull();
    expect(displayDeviceName()).toBe("edge-a");
  });
});
