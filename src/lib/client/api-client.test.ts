import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// api-client 是客户端模块：显式提供 localStorage / sessionStorage / fetch 三个全局。
// 核心断言：会话 token 只落 sessionStorage（关标签页即失效），绝不再写 localStorage。

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

describe("api-client 会话 token 存储位置", () => {
  it("setApiKey 只写 sessionStorage，不写 localStorage", async () => {
    const { setApiKey, getApiKey } = await loadClient();
    setApiKey("token-abc");
    expect(session.getItem("token-tracker-session-token")).toBe("token-abc");
    expect(local.getItem("token-tracker-session-token")).toBeNull();
    expect(getApiKey()).toBe("token-abc");
  });

  it("clearApiKey 只清 sessionStorage", async () => {
    const { setApiKey, clearApiKey, getApiKey } = await loadClient();
    setApiKey("token-abc");
    clearApiKey();
    expect(session.getItem("token-tracker-session-token")).toBeNull();
    expect(getApiKey()).toBeNull();
  });

  it("已有 token 在 localStorage 里也不会被读取（迁移后不复活旧存储）", async () => {
    local.setItem("token-tracker-session-token", "legacy-token");
    const { getApiKey } = await loadClient();
    expect(getApiKey()).toBeNull();
    expect(session.getItem("token-tracker-session-token")).toBeNull();
  });

  it("初始化时删除 localStorage 里的旧 token（只删不读）", async () => {
    local.setItem("token-tracker-session-token", "legacy-token");
    const { getApiKey } = await loadClient();
    expect(getApiKey()).toBeNull();
    expect(local.length).toBe(0); // 旧值已被清理，磁盘上不再驻留会话 token
    expect(local.getItem("token-tracker-session-token")).toBeNull();
  });

  it("setApiKey 早于首次 get 时也会清理旧 localStorage 残留", async () => {
    local.setItem("token-tracker-session-token", "legacy-token");
    const { setApiKey } = await loadClient();
    setApiKey("fresh-token");
    expect(local.getItem("token-tracker-session-token")).toBeNull();
    expect(session.getItem("token-tracker-session-token")).toBe("fresh-token");
  });

  it("apiLogin 成功后同样清理旧 localStorage 残留", async () => {
    local.setItem("token-tracker-session-token", "legacy-token");
    vi.stubGlobal("fetch", mockFetch(200, { success: true, token: "sess-new" }));
    const { apiLogin } = await loadClient();
    await apiLogin("Admin-Key-9f3a2b");
    expect(local.getItem("token-tracker-session-token")).toBeNull();
    expect(session.getItem("token-tracker-session-token")).toBe("sess-new");
  });

  it("clearApiKey 同时清 localStorage（登出后磁盘无残留）", async () => {
    local.setItem("token-tracker-session-token", "legacy-token");
    const { setApiKey, clearApiKey } = await loadClient();
    setApiKey("tok");
    local.setItem("token-tracker-session-token", "re-added");
    clearApiKey();
    expect(local.getItem("token-tracker-session-token")).toBeNull();
    expect(session.getItem("token-tracker-session-token")).toBeNull();
  });
});

describe("api-client 登录 / 续期", () => {
  it("apiLogin 成功后把 token 存进 sessionStorage", async () => {
    vi.stubGlobal("fetch", mockFetch(200, { success: true, token: "sess-1" }));
    const { apiLogin, getApiKey } = await loadClient();
    const res = await apiLogin("Admin-Key-9f3a2b", "123456");
    expect(res.ok).toBe(true);
    expect(getApiKey()).toBe("sess-1");
    expect(session.getItem("token-tracker-session-token")).toBe("sess-1");
    expect(local.getItem("token-tracker-session-token")).toBeNull();
  });

  it("apiFetch 带 X-API-Key，并在滑动续期头存在时回写 sessionStorage", async () => {
    const fetchMock = mockFetch(200, { success: true }, { "X-Session-Token": "sess-2" });
    vi.stubGlobal("fetch", fetchMock);
    const { setApiKey, apiFetch, getApiKey } = await loadClient();
    setApiKey("sess-1");
    const res = await apiFetch("/api/dashboard");
    expect(res.status).toBe(200);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(new Headers(init.headers).get("X-API-Key")).toBe("sess-1");
    expect(getApiKey()).toBe("sess-2");
    expect(session.getItem("token-tracker-session-token")).toBe("sess-2");
  });

  it("401 触发 notifyUnauthorized 并清空 sessionStorage token", async () => {
    vi.stubGlobal("fetch", mockFetch(401, { success: false }));
    const { setApiKey, apiFetch, getApiKey, registerUnauthorizedHandler } = await loadClient();
    const handler = vi.fn();
    registerUnauthorizedHandler(handler);
    setApiKey("sess-1");
    await apiFetch("/api/dashboard");
    expect(handler).toHaveBeenCalledTimes(1);
    expect(getApiKey()).toBeNull();
    expect(session.getItem("token-tracker-session-token")).toBeNull();
  });
});
