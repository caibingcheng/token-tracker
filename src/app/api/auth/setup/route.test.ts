import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { deleteAdminApiKey, deleteSetting, getAdminApiKey } from "@/lib/auth/settings";
import { MAX_AUTH_BODY_BYTES } from "@/lib/auth/request-body";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ORIG_ADMIN = process.env.ADMIN_API_KEY;
const ORIG_LEGACY = process.env.API_KEYS;

const STRONG = "Strong-Setup-Key-9f3a";
const WEAK = "weak1234";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-setup-route-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
  if (ORIG_ADMIN === undefined) delete process.env.ADMIN_API_KEY;
  else process.env.ADMIN_API_KEY = ORIG_ADMIN;
  if (ORIG_LEGACY === undefined) delete process.env.API_KEYS;
  else process.env.API_KEYS = ORIG_LEGACY;
});

beforeEach(async () => {
  delete process.env.ADMIN_API_KEY;
  delete process.env.API_KEYS;
  await deleteAdminApiKey();
  await deleteSetting("token_epoch").catch(() => {});
  vi.resetModules(); // 独立限流桶
});

afterEach(async () => {
  delete process.env.ADMIN_API_KEY;
  delete process.env.API_KEYS;
  await deleteAdminApiKey();
});

async function post(): Promise<(request: NextRequest) => Promise<Response>> {
  const mod = await import("./route");
  return mod.POST as unknown as (request: NextRequest) => Promise<Response>;
}

function jsonRequest(body: string | null, headers: Record<string, string> = {}): NextRequest {
  return new NextRequest("http://localhost/api/auth/setup", {
    method: "POST",
    headers,
    body,
  } as RequestInit);
}

function streamRequest(totalBytes: number): NextRequest {
  let sent = 0;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (sent >= totalBytes) {
        controller.close();
        return;
      }
      const size = Math.min(16 * 1024, totalBytes - sent);
      sent += size;
      controller.enqueue(new Uint8Array(size).fill(0x20));
    },
  });
  return new NextRequest("http://localhost/api/auth/setup", {
    method: "POST",
    body: stream,
    duplex: "half",
  } as RequestInit);
}

describe("POST /api/auth/setup - 弱 key 仅提示", () => {
  it("弱 key → 200，写库并签发会话", async () => {
    const POST = await post();
    const res = await POST(jsonRequest(JSON.stringify({ apiKey: WEAK })));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { token?: string };
    expect(body.token).toBeTruthy();
    expect(await getAdminApiKey()).toBe(WEAK);
  });

  it("弱 env key 已配置时向导仍关闭（403），且不发 token", async () => {
    process.env.ADMIN_API_KEY = WEAK;
    const POST = await post();
    const res = await POST(jsonRequest(JSON.stringify({ apiKey: STRONG })));
    expect(res.status).toBe(403);
    expect(await getAdminApiKey()).toBeNull();
  });
});

describe("POST /api/auth/setup - body 上限与限流顺序", () => {
  it("超大 body → 413，坏 JSON → 400", async () => {
    const POST = await post();
    expect(
      (await POST(jsonRequest(JSON.stringify({ apiKey: STRONG }), {
        "content-length": String(MAX_AUTH_BODY_BYTES + 1),
      }))).status
    ).toBe(413);
    expect((await POST(streamRequest(MAX_AUTH_BODY_BYTES + 1))).status).toBe(413);
    expect((await POST(jsonRequest("{bad"))).status).toBe(400);
  });

  it("缺 key / 坏 JSON / 超大 body 均计入限流，第 11 次 429", async () => {
    const POST = await post();
    expect((await POST(jsonRequest(JSON.stringify({})))).status).toBe(400);
    expect((await POST(jsonRequest("{bad"))).status).toBe(400);
    expect((await POST(streamRequest(MAX_AUTH_BODY_BYTES + 1))).status).toBe(413);
    for (let i = 0; i < 7; i++) {
      expect((await POST(jsonRequest(JSON.stringify({})))).status).toBe(400);
    }
    const limited = await POST(jsonRequest(JSON.stringify({ apiKey: STRONG })));
    expect(limited.status).toBe(429);
    expect(await getAdminApiKey()).toBeNull();
  });
});
