// Edge runtime 可用的会话 token 验签（WebCrypto HMAC-SHA256）。
// 与 node 侧 src/lib/auth/session.ts 保持相同的密钥派生方式：
// SHA-256(GATEWAY_SECRET + ":session-token") 作为 HMAC key。
// middleware 用（第一层防漏）；epoch/DB 校验仍由路由内 withAuth 完成。

const KEY_SALT = ":session-token";
const encoder = new TextEncoder();

// GATEWAY_SECRET 进程内不变：按 secret 键控缓存派生结果，避免每请求重复 digest+importKey
const keyCache = new Map<string, Promise<CryptoKey>>();

export async function deriveEdgeSessionKey(secret: string): Promise<CryptoKey> {
  let cached = keyCache.get(secret);
  if (!cached) {
    cached = (async () => {
      const digest = await crypto.subtle.digest(
        "SHA-256",
        encoder.encode(`${secret}${KEY_SALT}`)
      );
      return crypto.subtle.importKey(
        "raw",
        digest,
        { name: "HMAC", hash: "SHA-256" },
        false,
        ["verify"]
      );
    })();
    keyCache.set(secret, cached);
  }
  return cached;
}

export function decodeBase64Url(input: string): Uint8Array<ArrayBuffer> | null {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const padLen = (4 - (padded.length % 4)) % 4;
  const b64 = padded + "=".repeat(padLen);
  try {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch {
    return null;
  }
}

export async function verifyEdgeSignature(
  key: CryptoKey,
  payload: string,
  sig: string
): Promise<boolean> {
  const sigBytes = decodeBase64Url(sig);
  if (!sigBytes) return false;
  try {
    return await crypto.subtle.verify("HMAC", key, sigBytes, encoder.encode(payload));
  } catch {
    return false;
  }
}

export interface EdgeSessionPayload {
  exp: number;
}

// 解析 payload 并校验 exp；epoch/keyId 检查留给 withAuth（middleware 无法访问 DB）
export function parseEdgeSessionPayload(payload: string): EdgeSessionPayload | null {
  let parsed: Record<string, unknown>;
  try {
    const raw = decodeBase64Url(payload);
    if (!raw) return null;
    parsed = JSON.parse(new TextDecoder().decode(raw)) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (typeof parsed.exp !== "number" || parsed.exp <= Date.now()) {
    return null;
  }
  return { exp: parsed.exp };
}
