import { describe, it, expect } from "vitest";
import { NextRequest, NextResponse } from "./next-shim";

describe("NextRequest shim", () => {
  it("带 body 构造不抛 duplex 错，body 可读", async () => {
    const req = new NextRequest("http://localhost/api/x", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ a: 1 }),
    });
    expect(req.method).toBe("POST");
    expect(await req.json()).toEqual({ a: 1 });
  });

  it("无 body 构造（GET）正常", () => {
    const req = new NextRequest("http://localhost/api/x?b=2");
    expect(req.method).toBe("GET");
    expect(req.body).toBeNull();
  });

  it("cookies.get 解析 cookie 头，未命中返回 undefined", () => {
    const req = new NextRequest("http://localhost/api/x", {
      headers: { cookie: "tt_session=abc.def; other=1" },
    });
    expect(req.cookies.get("tt_session")).toEqual({
      name: "tt_session",
      value: "abc.def",
    });
    expect(req.cookies.get("missing")).toBeUndefined();
    expect(new NextRequest("http://localhost/").cookies.get("x")).toBeUndefined();
  });

  // 下面三条对齐 Next 的 RequestCookies（@edge-runtime/cookies parseCookie）：
  // 同名后写胜出、值 decodeURIComponent、解码失败整对丢弃
  it("cookies 同名时后写胜出（浏览器按 Path 排序发送，Next 取最后一个）", () => {
    const req = new NextRequest("http://localhost/api/x", {
      headers: { cookie: "tt_session=first; tt_session=last" },
    });
    expect(req.cookies.get("tt_session")?.value).toBe("last");
  });

  it("cookies 值做 decodeURIComponent", () => {
    const req = new NextRequest("http://localhost/api/x", {
      headers: { cookie: "v=a%2Eb%20c" },
    });
    expect(req.cookies.get("v")?.value).toBe("a.b c");
  });

  it("cookies 解码失败的对整对丢弃（其它对仍可用）", () => {
    const req = new NextRequest("http://localhost/api/x", {
      headers: { cookie: "bad=%E0%A4%A; tt_session=abc.def" },
    });
    expect(req.cookies.get("bad")).toBeUndefined();
    expect(req.cookies.get("tt_session")?.value).toBe("abc.def");
  });

  it("nextUrl.searchParams 可用", () => {
    const req = new NextRequest("http://localhost/api/x?search=gpt&provider=openai");
    expect(req.nextUrl.searchParams.get("search")).toBe("gpt");
    expect(req.nextUrl.pathname).toBe("/api/x");
  });

  it("从 Request 实例构造", async () => {
    const raw = new Request("http://localhost/api/x", {
      method: "POST",
      body: "hi",
      duplex: "half",
    } as RequestInit);
    const req = new NextRequest(raw);
    expect(req.url).toBe("http://localhost/api/x");
    expect(await req.text()).toBe("hi");
  });
});

describe("NextResponse shim", () => {
  it("json 返回 NextResponse 实例，status/headers 正确", async () => {
    const res = NextResponse.json({ ok: true }, { status: 401 });
    expect(res).toBeInstanceOf(NextResponse);
    expect(res).toBeInstanceOf(Response);
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual({ ok: true });
  });

  it("json 默认 200", () => {
    expect(NextResponse.json({}).status).toBe(200);
  });

  it("next() 带 x-middleware-next 头", () => {
    const res = NextResponse.next();
    expect(res.headers.get("x-middleware-next")).toBe("1");
    expect(res.status).toBe(200);
  });

  it("headers.append Set-Cookie 可用（guard unauthorized 依赖）", () => {
    const res = NextResponse.json({ success: false }, { status: 401 });
    res.headers.append("Set-Cookie", "tt_session=; Max-Age=0");
    expect(res.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });
});
