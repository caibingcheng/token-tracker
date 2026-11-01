import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// api-client 是客户端模块：浏览器登录态 = httpOnly cookie（JS 读不到、不存储），
// 前端无任何 token 存储逻辑。核心断言：apiFetch 不带 X-API-Key、不发 token 存储调用，
// 401 触发 notifyUnauthorized；登录/登出/探测走对应 auth 端点；
// 模块初始化清理旧版 sessionStorage / localStorage 里的明文 token 残留（只删不读）。

class MemoryStorage {
  private map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
  key(index: number): string | null {
    return Array.from(this.map.keys())[index] ?? null;
  }
  get length(): number {
    return this.map.size;
  }
}

let session: MemoryStorage;
let local: MemoryStorage;

function mockFetch(status: number, body: unknown, headers: Record<string, string> = {}) {
  return vi.fn(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    })
  );
}

beforeEach(() => {
  session = new MemoryStorage();
  local = new MemoryStorage();
  vi.stubGlobal("sessionStorage", session);
  vi.stubGlobal("localStorage", local);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function loadClient() {
  return import("./api-client");
}

describe("api-client 登录 / 设置", () => {
  it("apiLogin 成功返回 ok 并透传 viaRecoveryCode", async () => {
    vi.stubGlobal(
      "fetch",
      mockFetch(200, { success: true, token: "sess-1", viaRecoveryCode: true })
    );
    const { apiLogin } = await loadClient();
    const res = await apiLogin("Admin-Key-9f3a2b", "123456");
    expect(res).toEqual({ ok: true, viaRecoveryCode: true });
  });

  it("apiLogin 失败返回错误文案", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { success: false, error: "Invalid credentials" }));
    const { apiLogin } = await loadClient();
    const res = await apiLogin("wrong");
    expect(res.ok).toBe(false);
    expect(res.error).toBe("Invalid credentials");
  });

  it("apiSetupSubmit 成功返回 ok", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { success: true, token: "sess-1" }));
    const { apiSetupSubmit } = await loadClient();
    expect(await apiSetupSubmit("Admin-Key-9f3a2b")).toEqual({ ok: true });
  });

  it("apiLogout POST /api/auth/logout，返回 ok 状态", async () => {
    const fetchMock = mockFetch(200, { success: true });
    vi.stubGlobal("fetch", fetchMock);
    const { apiLogout } = await loadClient();
    expect(await apiLogout()).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", { method: "POST" });
  });

  it("apiLogout 网络失败返回 false（调用方据此决定 UI 行为）", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("network down");
      })
    );
    const { apiLogout } = await loadClient();
    expect(await apiLogout()).toBe(false);
  });
});

describe("api-client 会话探测", () => {
  it("200 → 已登录", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { authenticated: true }));
    const { checkSession } = await loadClient();
    expect(await checkSession()).toBe(true);
  });

  it("401 → 未登录，且不触发 notifyUnauthorized（裸 fetch 探测）", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { success: false }));
    const { checkSession, registerUnauthorizedHandler } = await loadClient();
    const handler = vi.fn();
    registerUnauthorizedHandler(handler);
    expect(await checkSession()).toBe(false);
    expect(handler).not.toHaveBeenCalled();
  });
});

describe("api-client 旧版 token 残留清理（只删不读）", () => {
  it("模块加载即清掉 sessionStorage / localStorage 里的旧明文 token", async () => {
    session.setItem("token-tracker-session-token", "legacy-session-token");
    local.setItem("token-tracker-session-token", "legacy-local-token");
    await loadClient();
    expect(session.getItem("token-tracker-session-token")).toBeNull();
    expect(local.getItem("token-tracker-session-token")).toBeNull();
  });

  it("无 storage 全局（异常环境）时初始化不抛", async () => {
    vi.unstubAllGlobals();
    vi.stubGlobal("sessionStorage", undefined);
    vi.stubGlobal("localStorage", undefined);
    await expect(loadClient()).resolves.toBeTruthy();
  });
});

describe("api-client apiFetch", () => {
  it("不携带 X-API-Key header（登录态在 httpOnly cookie，浏览器自动带）", async () => {
    const fetchMock = mockFetch(200, { success: true });
    vi.stubGlobal("fetch", fetchMock);
    const { apiFetch } = await loadClient();
    const res = await apiFetch("/api/dashboard");
    expect(res.status).toBe(200);
    const init = fetchMock.mock.calls[0]![1] as RequestInit | undefined;
    expect(new Headers(init?.headers).get("X-API-Key")).toBeNull();
  });

  it("401 触发 notifyUnauthorized", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { success: false }));
    const { apiFetch, registerUnauthorizedHandler } = await loadClient();
    const handler = vi.fn();
    registerUnauthorizedHandler(handler);
    await apiFetch("/api/dashboard");
    expect(handler).toHaveBeenCalledTimes(1);
  });
});
