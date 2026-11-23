// next/server 兼容层：把 route handler 实际用到的 API 面落到 Web 标准 Request/Response 上。
// 存在原因：服务端已从 Next 换成 Hono（见 docs/agents/deployment.md），route 文件里的
// `from "next/server"` 由三处别名统一指向本文件（tsconfig paths / vitest alias / esbuild alias），
// 业务代码零改写。新增对 next/server API 的依赖时必须先在这里补实现，否则 tsc 不会报、运行时才炸。
//
// 覆盖面按全仓统计选型（见 git 历史）：NextResponse.json、NextResponse.next（仅 proxy 判停用）、
// NextRequest 构造（route 单测大量 new NextRequest(url, {body})）、.cookies.get、.nextUrl.searchParams。
// 未覆盖且无人使用：cookies.set / redirect / formData 等 —— 用到时再加。

export class NextRequest extends Request {
  constructor(input: RequestInfo | URL, init: RequestInit = {}) {
    const url = input instanceof Request ? input.url : String(input);
    // node Request 在有 body 时要求 duplex:'half'，否则构造直接抛错
    //（与 next 官方 spec-extension/request.js 同款处理；input 为 Request 时 body 早已定型，不补）
    if (init.body && (init as RequestInit & { duplex?: string }).duplex !== "half") {
      init = { ...init, duplex: "half" } as RequestInit;
    }
    if (input instanceof Request) super(input, init);
    else super(url, init);
  }

  // 只读 cookie 视图：readSessionCookie(cookies) 只用 get(name)?.value。
  // 值按 cookie 原文返回（不 decodeURIComponent）——与 Next RequestCookies 一致，
  // 本应用的会话 token 是 base64url，字符集天然在 cookie-octet 内
  get cookies(): { get(name: string): { name: string; value: string } | undefined } {
    const header = this.headers.get("cookie");
    return {
      get: (name: string) => {
        if (!header) return undefined;
        for (const pair of header.split(";")) {
          const eq = pair.indexOf("=");
          if (eq < 0) continue;
          if (pair.slice(0, eq).trim() === name) {
            return { name, value: pair.slice(eq + 1).trim() };
          }
        }
        return undefined;
      },
    };
  }

  // route 里只用到 nextUrl.searchParams（model-pricing / sync-instances 两处）；
  // URL 自带 searchParams，语义足够
  get nextUrl(): URL {
    return new URL(this.url);
  }
}

export class NextResponse extends Response {
  // 先走运行时自带的 Response.json（content-type / status 处理与平台一致），
  // 再包成 NextResponse：guard.ts 有 `response instanceof NextResponse` 分支
  static json(body: unknown, init?: ResponseInit): NextResponse {
    const res = Response.json(body, init);
    return new NextResponse(res.body, {
      status: res.status,
      statusText: res.statusText,
      headers: res.headers,
    });
  }

  // 仅 proxy（会话验签层）用：`x-middleware-next: 1` 表示「放行到下一层」，
  // Hono 侧 verify-session 中间件读到该头即调用 next()
  static next(init?: ResponseInit): NextResponse {
    const headers = new Headers(init?.headers);
    headers.set("x-middleware-next", "1");
    return new NextResponse(null, { ...init, headers });
  }
}
