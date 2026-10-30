"use client";

// 会话 token 存 sessionStorage 而非 localStorage：
// - token 效力等同登录态，localStorage 永久驻留（关标签页仍在）+ 同源任意脚本可读
// - sessionStorage 按标签页隔离，关闭即失效，缩小持久化暴露面
// 代价：新开标签页需重新登录（个人网关可接受）
const STORAGE_KEY = "token-tracker-session-token";

let storedKey: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

// 旧版本把会话 token 存在 localStorage（永久驻留）。切到 sessionStorage 后必须主动清理
// 同一 key 的残留项：否则明文 token 仍留在浏览器磁盘上（关标签页也不失效），
// 迁移就等于没做。清理策略 = 「只删不读」：旧值一概不认（可能已过期/已吊销）。
function purgeLegacyLocalStorage(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage errors（无 localStorage / 隐私模式）
  }
}

function readFromStorage(): string | null {
  // 初始化即清理旧存储（不读取其值）
  purgeLegacyLocalStorage();
  try {
    return sessionStorage.getItem(STORAGE_KEY);
  } catch {
    return null;
  }
}

export function getApiKey(): string | null {
  if (storedKey === null) {
    storedKey = readFromStorage();
  }
  return storedKey;
}

export function setApiKey(key: string): void {
  storedKey = key;
  // 每次写入都顺手清掉旧 localStorage 残留（首次 set 早于首次 get 时也能清理）
  purgeLegacyLocalStorage();
  try {
    sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // ignore storage errors
  }
}

export function clearApiKey(): void {
  storedKey = null;
  purgeLegacyLocalStorage();
  try {
    sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

export function registerUnauthorizedHandler(handler: () => void): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) {
      unauthorizedHandler = null;
    }
  };
}

export function notifyUnauthorized(): void {
  clearApiKey();
  unauthorizedHandler?.();
}

// 登录：原始 API key（+ 可选 TOTP 动态码或 recovery code）换取会话 token，仅此接口接受原始 key。
// 服务端对 key 无效 / 缺 TOTP / TOTP 错误统一返回 401 同文案（不暴露 key 有效性），
// 前端两步流程（先 key 后 code）由组件本地驱动，不依赖服务端区分。
// viaRecoveryCode：本次登录是否通过 recovery code 完成（true 时前端需弹窗提醒）
export async function apiLogin(
  apiKey: string,
  totpCode?: string
): Promise<{ ok: boolean; error?: string; viaRecoveryCode?: boolean }> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey, totpCode }),
  });
  const json = await res.json();
  if (res.ok && json.token) {
    setApiKey(json.token as string);
    return { ok: true, viaRecoveryCode: json.viaRecoveryCode === true };
  }
  return { ok: false, error: json.error || "Login failed" };
}

// 首次设置：探测是否需设置向导，以及提交初始 admin key 换取会话 token
export async function apiSetup(): Promise<{
  setupRequired: boolean;
  authDisabled: boolean;
}> {
  const res = await fetch("/api/auth/setup");
  if (res.ok) {
    const json = (await res.json()) as {
      setupRequired?: boolean;
      authDisabled?: boolean;
    };
    return {
      setupRequired: json.setupRequired === true,
      authDisabled: json.authDisabled === true,
    };
  }
  return { setupRequired: false, authDisabled: false };
}

export async function apiSetupSubmit(
  apiKey: string
): Promise<{ ok: boolean; error?: string }> {
  const res = await fetch("/api/auth/setup", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey }),
  });
  const json = await res.json();
  if (res.ok && json.token) {
    setApiKey(json.token as string);
    return { ok: true };
  }
  return { ok: false, error: json.error || "Setup failed" };
}

export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const headers = new Headers(init?.headers);
  const key = getApiKey();
  if (key) {
    headers.set("X-API-Key", key);
  }

  const res = await fetch(input, { ...init, headers });

  // 滑动续期：guard 认证通过且 token 即将过期时在响应头下发新 token
  const newToken = res.headers.get("X-Session-Token");
  if (newToken) {
    setApiKey(newToken);
  }

  if (res.status === 401) {
    notifyUnauthorized();
  }

  return res;
}
