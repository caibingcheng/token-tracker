import { describe, it, expect } from "vitest";
import { reserveInflight, getInflight } from "./quota-inflight";

describe("quota in-flight 预留", () => {
  it("预留计入请求数与估算 token，释放后归零", () => {
    const releaseA = reserveInflight(101, 100);
    const releaseB = reserveInflight(101, 50);
    expect(getInflight(101)).toEqual({ rpm: 2, tokens: 150 });

    releaseA();
    expect(getInflight(101)).toEqual({ rpm: 1, tokens: 50 });

    releaseB();
    expect(getInflight(101)).toEqual({ rpm: 0, tokens: 0 });
  });

  it("释放是幂等的（重复调用不会把别人的预留减掉）", () => {
    const releaseA = reserveInflight(102, 10);
    reserveInflight(102, 20);
    releaseA();
    releaseA();
    expect(getInflight(102)).toEqual({ rpm: 1, tokens: 20 });
  });

  it("按 vk 隔离；未知 vk 返回零", () => {
    const releaseA = reserveInflight(103, 5);
    expect(getInflight(104)).toEqual({ rpm: 0, tokens: 0 });
    expect(getInflight(103).rpm).toBe(1);
    releaseA();
  });

  it("非法/负 token 估算归一为 0（只计请求数）", () => {
    const release = reserveInflight(105, -1);
    expect(getInflight(105)).toEqual({ rpm: 1, tokens: 0 });
    release();
    const releaseNaN = reserveInflight(105, Number.NaN);
    expect(getInflight(105)).toEqual({ rpm: 1, tokens: 0 });
    releaseNaN();
  });
});
