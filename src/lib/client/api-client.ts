"use client";

// 浏览器登录态 = httpOnly Cookie（tt_session，服务端 login/setup 下发，见
// src/lib/auth/session-cookie.ts）：JS 读不到 token，同源 fetch 自动携带，
// 关浏览器重开仍在（直至过期 / 吊销 / 登出）。前端因此没有任何 token 存储逻辑。
// 脚本场景（curl 等）仍可用 X-API-Key header 带会话 token 直连，不经此模块。

// 旧版本把会话 token 存在 sessionStorage / localStorage（JS 可读）。切到 httpOnly cookie 后
// 必须清理残留：升级前的明文 token 在过期前仍可被同源脚本读走，迁移就等于没做。
// 清理策略 = 「只删不读」：旧值一概不认（可能已过期/已吊销）
const LEGACY_STORAGE_KEY = "token-tracker-session-token";

function purgeLegacyTokenStorage(): void {
  try {
    sessionStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore storage errors（无 sessionStorage / 隐私模式）
  }
  try {
    localStorage.removeItem(LEGACY_STORAGE_KEY);
  } catch {
    // ignore storage errors
  }
}

purgeLegacyTokenStorage();

let unauthorizedHandler: (() => void) | null = null;

export function registerUnauthorizedHandler(handler: () => void): () => void {
  unauthorizedHandler = handler;
  return () => {
    if (unauthorizedHandler === handler) {
      unauthorizedHandler = null;
    }
  };
}

// 401 时服务端已下发过期 Set-Cookie 清掉失效 cookie，这里只切 UI 状态回登录页
export function notifyUnauthorized(): void {
  unauthorizedHandler?.();
}

// 登录态探测（ApiKeyGate 首帧）：httpOnly cookie 前端不可读，只能探。
// 200 = 已登录；401 = 未登录/已过期。用裸 fetch 而非 apiFetch —— 探测失败
// 不该触发 notifyUnauthorized（会往登录表单上打错误文案）
export async function checkSession(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/session", { method: "GET" });
    return res.ok;
  } catch {
    return false;
  }
}

// 登录：原始 API key（+ 可选 TOTP 动态码或 recovery code）换取会话 cookie，仅此接口接受原始 key。
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
  if (res.ok && json.success) {
    return { ok: true, viaRecoveryCode: json.viaRecoveryCode === true };
  }
  return { ok: false, error: json.error || "Login failed" };
}

// 登出：吊销服务端 httpOnly cookie（过期 Set-Cookie）。调用方须 await 本函数再切登录 UI——
// 否则登出响应晚于下一次登录回来时，会把新登录的 cookie 清掉（竞态）
export async function apiLogout(): Promise<boolean> {
  try {
    const res = await fetch("/api/auth/logout", { method: "POST" });
    return res.ok;
  } catch {
    // 网络失败：服务端不可达时 cookie 无从清起，返回 false 由调用方决定是否仍切登录 UI
    return false;
  }
}

// 首次设置：探测是否需设置向导，以及提交初始 admin key 换取会话 cookie
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
  if (res.ok && json.success) {
    return { ok: true };
  }
  return { ok: false, error: json.error || "Setup failed" };
}

// 同源 fetch：浏览器自动携带 tt_session cookie；滑动续期由服务端
// 在剩余有效期不足一半时直接 Set-Cookie 续上，前端无感知
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit
): Promise<Response> {
  const res = await fetch(input, init);

  if (res.status === 401) {
    notifyUnauthorized();
  }

  return res;
}
