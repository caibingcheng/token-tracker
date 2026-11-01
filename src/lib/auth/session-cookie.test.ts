import { describe, it, expect } from "vitest";
import {
  SESSION_COOKIE_NAME,
  buildSessionCookie,
  buildClearSessionCookie,
  shouldSecureCookie,
  readSessionCookie,
} from "./session-cookie";

describe("buildSessionCookie", () => {
  it("包含 HttpOnly / SameSite=Lax / Path=/ / Max-Age，https 下带 Secure", () => {
    const cookie = buildSessionCookie("abc.def", 60 * 60 * 1000, true);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=abc.def`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Max-Age=3600");
    expect(cookie).toContain("Secure");
  });

  it("非安全上下文不带 Secure", () => {
    const cookie = buildSessionCookie("abc.def", 1000, false);
    expect(cookie).not.toContain("Secure");
    expect(cookie).toContain("Max-Age=1"); // ttl < 1s 收敛到 1s，防 Max-Age=0 变清除
  });
});

describe("buildClearSessionCookie", () => {
  it("Max-Age=0 立即过期，与设置时同属性（Path/SameSite/Secure 一致才能覆盖）", () => {
    const cookie = buildClearSessionCookie(true);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);
    expect(cookie).toContain("Max-Age=0");
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });
});

describe("shouldSecureCookie", () => {
  it("https 与 localhost / 127.0.0.1 → Secure", () => {
    expect(shouldSecureCookie("https://tracker.example.com/api/x")).toBe(true);
    expect(shouldSecureCookie("http://localhost:3000/api/x")).toBe(true);
    expect(shouldSecureCookie("http://127.0.0.1:3000/api/x")).toBe(true);
  });

  it("http + LAN IP / 域名 → 不设 Secure（否则浏览器拒收导致登录死循环）", () => {
    expect(shouldSecureCookie("http://192.168.1.10:3000/api/x")).toBe(false);
    expect(shouldSecureCookie("http://tracker.example.com/api/x")).toBe(false);
  });
});

describe("readSessionCookie", () => {
  it("读到值 / 无 cookie 返回 null", () => {
    expect(readSessionCookie({ get: () => ({ value: "tok" }) })).toBe("tok");
    expect(readSessionCookie({ get: () => undefined })).toBeNull();
  });
});
