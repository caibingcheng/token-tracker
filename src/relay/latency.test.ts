// relay 侧 RTT 分钟桶：聚合口径与窗口修剪
import { describe, it, expect, beforeEach } from "vitest";
import { RTT_TICK_MS, RTT_WINDOW_MS, recordRtt, resetRttForTest, rttSnapshot } from "./latency";

const T0 = 1_700_000_000_000; // 任意整分钟对齐以外的时间戳，用 bucketStart 归一

function startOf(ms: number): number {
  return Math.floor(ms / RTT_TICK_MS) * RTT_TICK_MS;
}

describe("relay RTT 分钟桶", () => {
  beforeEach(() => resetRttForTest());

  it("同一分钟多次样本 → count/sum/max/last", () => {
    recordRtt("plan", 100, T0);
    recordRtt("plan", 300, T0 + 5_000);
    const [bucket] = rttSnapshot(T0 + 6_000);
    expect(bucket).toEqual({
      kind: "plan",
      start: startOf(T0),
      count: 2,
      sumMs: 400,
      maxMs: 300,
      lastMs: 300,
    });
  });

  it("只报上一分钟 + 当前分钟，且两个 kind 分开", () => {
    recordRtt("plan", 10, T0);
    recordRtt("report", 20, T0);
    recordRtt("plan", 30, T0 + RTT_TICK_MS);
    const snap = rttSnapshot(T0 + RTT_TICK_MS + 1_000);
    expect(snap).toHaveLength(3);
    expect(snap.filter((b) => b.start === startOf(T0)).map((b) => b.kind).sort()).toEqual([
      "plan",
      "report",
    ]);
    expect(snap.filter((b) => b.start === startOf(T0) + RTT_TICK_MS)).toHaveLength(1);
  });

  it("更早的桶不再上报（只报最近两桶）", () => {
    recordRtt("plan", 10, T0);
    const snap = rttSnapshot(T0 + 3 * RTT_TICK_MS);
    expect(snap).toEqual([]);
  });

  it("无样本 → 空数组", () => {
    expect(rttSnapshot(T0)).toEqual([]);
  });

  it("窗口外的桶被修剪", () => {
    recordRtt("plan", 10, T0);
    recordRtt("plan", 20, T0 + RTT_WINDOW_MS);
    const snap = rttSnapshot(T0 + RTT_WINDOW_MS);
    // 只剩当前桶：5h 前的桶已出窗口
    expect(snap).toHaveLength(1);
    expect(snap[0].start).toBe(startOf(T0 + RTT_WINDOW_MS));
  });

  it("负数 / 非有限 / 超窗口长度的样本被丢弃", () => {
    recordRtt("plan", -1, T0);
    recordRtt("plan", Number.NaN, T0);
    recordRtt("plan", Number.POSITIVE_INFINITY, T0);
    recordRtt("plan", RTT_WINDOW_MS + 1, T0);
    expect(rttSnapshot(T0)).toEqual([]);
  });
});
