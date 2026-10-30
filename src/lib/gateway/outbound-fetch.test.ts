import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { outboundFetch, setOutboundFetchImpl } from "./outbound-fetch";
import { getDirectDispatcher } from "./proxy-dispatcher";

// 统一出站边界：所有带真实 key 的请求都经过 outboundFetch，
// 这里同时是运行时 URL 安全边界（写入校验挡不住存量行 / env / 直接改库）。

const ORIG_ALLOW = process.env.ALLOW_PRIVATE_UPSTREAMS;
let calls: Array<{ input: unknown; init: Record<string, unknown> }>;

beforeEach(() => {
  calls = [];
  delete process.env.ALLOW_PRIVATE_UPSTREAMS;
  setOutboundFetchImpl((input: unknown, init: Record<string, unknown>) => {
    calls.push({ input, init });
    return Promise.resolve(new Response("{}", { status: 200 }));
  });
});

afterEach(() => {
  setOutboundFetchImpl(null);
  if (ORIG_ALLOW === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAMS;
  else process.env.ALLOW_PRIVATE_UPSTREAMS = ORIG_ALLOW;
});

describe("outboundFetch - 运行时 URL 安全边界", () => {
  it("放行 https 公网目标，并把 init 透传（scope 不传底层）", async () => {
    const res = await outboundFetch("https://api.example.com/v1/chat", {
      method: "POST",
      redirect: "manual",
      dispatcher: getDirectDispatcher(),
    });
    expect(res.status).toBe(200);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.init.redirect).toBe("manual");
    expect(calls[0]!.init.dispatcher).toBeDefined();
    expect("scope" in calls[0]!.init).toBe(false);
  });

  it("放行公网明文 http（upstream / proxy 口径）", async () => {
    for (const url of ["http://api.example.com/v1", "http://8.8.8.8:8080/v1"]) {
      const res = await outboundFetch(url, { method: "POST" });
      expect(res.status).toBe(200);
    }
    expect(calls).toHaveLength(2);
  });

  it("拒绝字面私网/环回/元数据地址（不走 DNS 的连接也拦得住）", async () => {
    for (const url of [
      "https://127.0.0.1:8080/v1",
      "https://169.254.169.254/latest/meta-data",
      "https://[::1]:8080/v1",
    ]) {
      await expect(outboundFetch(url, { method: "POST" })).rejects.toThrow(/private/);
    }
    expect(calls).toHaveLength(0);
  });

  it("sync scope 允许 loopback 明文 http（localhost / 127.x / ::1）", async () => {
    for (const url of [
      "http://localhost:3000/ingest/records",
      "http://127.0.0.1:3000/ingest/records",
      "http://[::1]:3000/ingest/records",
    ]) {
      const res = await outboundFetch(url, { method: "POST", scope: "sync" });
      expect(res.status).toBe(200);
    }
    expect(calls).toHaveLength(3);
    expect("scope" in calls[0]!.init).toBe(false);
  });

  it("loopback 例外只属于 sync：upstream scope 的 loopback 字面 IP 仍拒绝", async () => {
    await expect(
      outboundFetch("http://127.0.0.1:3000/v1/chat", { method: "POST" })
    ).rejects.toThrow(/private/);
    expect(calls).toHaveLength(0);
  });

  it("ALLOW_PRIVATE_UPSTREAMS=true 时放行内网明文（统一逃生开关）", async () => {
    process.env.ALLOW_PRIVATE_UPSTREAMS = "true";
    await expect(
      outboundFetch("http://192.168.1.5:8000/v1", { method: "POST" })
    ).resolves.toBeInstanceOf(Response);
    expect(calls).toHaveLength(1);
  });

  it("非法 scheme 直接拒绝", async () => {
    await expect(outboundFetch("ftp://example.com/x")).rejects.toThrow(/http/);
    expect(calls).toHaveLength(0);
  });
});
