import { describe, it, expect, afterEach } from "vitest";
import {
  isLocalAdminBypassEnabled,
  isLoopbackHost,
  canBypassAuth,
} from "./local-bypass";

function req(host: string | null): { headers: Headers } {
  const headers = new Headers();
  if (host !== null) headers.set("host", host);
  return { headers };
}

afterEach(() => {
  delete process.env.LOCAL_ADMIN_BYPASS;
});

describe("isLocalAdminBypassEnabled", () => {
  it("未设置 env 时关闭", () => {
    expect(isLocalAdminBypassEnabled()).toBe(false);
  });

  it("1 / true 开启，其余值关闭", () => {
    process.env.LOCAL_ADMIN_BYPASS = "1";
    expect(isLocalAdminBypassEnabled()).toBe(true);
    process.env.LOCAL_ADMIN_BYPASS = "true";
    expect(isLocalAdminBypassEnabled()).toBe(true);
    process.env.LOCAL_ADMIN_BYPASS = "yes";
    expect(isLocalAdminBypassEnabled()).toBe(false);
    process.env.LOCAL_ADMIN_BYPASS = "0";
    expect(isLocalAdminBypassEnabled()).toBe(false);
  });
});

describe("isLoopbackHost", () => {
  it("识别 localhost / 127.x / ::1（含端口）", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("localhost:39001")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("127.0.0.1:39001")).toBe(true);
    expect(isLoopbackHost("127.1.2.3:39001")).toBe(true);
    expect(isLoopbackHost("::1")).toBe(true);
    expect(isLoopbackHost("[::1]:3000")).toBe(true);
    expect(isLoopbackHost("LOCALHOST:39001")).toBe(true);
  });

  it("拒绝非 loopback 与空值", () => {
    expect(isLoopbackHost(null)).toBe(false);
    expect(isLoopbackHost("")).toBe(false);
    expect(isLoopbackHost("example.com")).toBe(false);
    expect(isLoopbackHost("192.168.1.10:39001")).toBe(false);
    expect(isLoopbackHost("localhost.evil.com")).toBe(false);
  });
});

describe("canBypassAuth", () => {
  it("env 开启 + loopback Host 才放行", () => {
    process.env.LOCAL_ADMIN_BYPASS = "1";
    expect(canBypassAuth(req("127.0.0.1:39001"))).toBe(true);
    expect(canBypassAuth(req("example.com"))).toBe(false);
    expect(canBypassAuth(req(null))).toBe(false);
  });

  it("env 未开启时一律不放行", () => {
    expect(canBypassAuth(req("127.0.0.1:39001"))).toBe(false);
  });
});
