import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { displayDeviceName, getCenterDeviceName, setCenterDeviceName } from "./state";

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
