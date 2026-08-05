"use client";

const STORAGE_KEY = "token-tracker-api-key";

let storedKey: string | null = null;
let unauthorizedHandler: (() => void) | null = null;

function readFromStorage(): string | null {
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
  try {
    sessionStorage.setItem(STORAGE_KEY, key);
  } catch {
    // ignore storage errors
  }
}

export function clearApiKey(): void {
  storedKey = null;
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

  if (res.status === 401) {
    notifyUnauthorized();
  }

  return res;
}
