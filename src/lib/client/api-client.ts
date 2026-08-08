"use client";

const STORAGE_KEY = "token-tracker-session-token";

let storedKey: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

function readFromStorage(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY);
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
  try {
    localStorage.setItem(STORAGE_KEY, key);
  } catch {
    // ignore storage errors
  }
}

export function clearApiKey(): void {
  storedKey = null;
  try {
    localStorage.removeItem(STORAGE_KEY);
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

// 登录：原始 API key（+ 可选 TOTP 动态码）换取会话 token，仅此接口接受原始 key
export async function apiLogin(
  apiKey: string,
  totpCode?: string
): Promise<{ ok: boolean; totpRequired?: boolean; error?: string }> {
  const res = await fetch("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ apiKey, totpCode }),
  });
  const json = await res.json();
  if (res.ok && json.token) {
    setApiKey(json.token as string);
    return { ok: true };
  }
  if (res.status === 401 && json.totpRequired) {
    return { ok: false, totpRequired: true, error: json.error };
  }
  return { ok: false, error: json.error || "Login failed" };
}

// 首次设置：探测是否需设置向导，以及提交初始 admin key 换取会话 token
export async function apiSetup(): Promise<{ setupRequired: boolean }> {
  const res = await fetch("/api/auth/setup");
  if (res.ok) {
    const json = (await res.json()) as { setupRequired?: boolean };
    return { setupRequired: json.setupRequired === true };
  }
  return { setupRequired: false };
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
