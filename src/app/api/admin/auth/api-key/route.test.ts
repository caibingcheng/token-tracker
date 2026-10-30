import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { PATCH } from "./route";
import {
  setAdminApiKey,
  getAdminApiKey,
  getTokenEpoch,
  deleteSetting,
} from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;

const ADMIN_KEY = "Current-Strong-Key-9f3a";
const STRONG_NEW = "Next-Strong-Key-4c8d";
const WEAK_NEW = "weak1234";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-api-key-route-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
});

beforeEach(async () => {
  await setAdminApiKey(ADMIN_KEY);
  await deleteSetting("totp_enabled").catch(() => {});
  await deleteSetting("totp_secret").catch(() => {});
  await deleteSetting("token_epoch").catch(() => {});
});

async function makeToken(): Promise<string> {
  return signSessionToken(await getTokenEpoch(), keyFingerprint(ADMIN_KEY), 60_000);
}

function patchRequest(body: unknown, token: string): NextRequest {
  return new NextRequest("http://localhost/api/admin/auth/api-key", {
    method: "PATCH",
    headers: { "X-API-Key": token, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function patchHandler(): (request: NextRequest, ctx: never) => Promise<Response> {
  return PATCH as unknown as (request: NextRequest, ctx: never) => Promise<Response>;
}

describe("PATCH /api/admin/auth/api-key", () => {
  it("未带会话 token → 401", async () => {
    const res = await patchHandler()(patchRequest({ newApiKey: STRONG_NEW }, ""), {} as never);
    expect(res.status).toBe(401);
  });

  it("弱新 key → 200，落库并 bump token_epoch", async () => {
    const token = await makeToken();
    const epochBefore = await getTokenEpoch();
    const res = await patchHandler()(patchRequest({ newApiKey: WEAK_NEW }, token), {} as never);
    expect(res.status).toBe(200);
    expect(await getAdminApiKey()).toBe(WEAK_NEW);
    expect(await getTokenEpoch()).toBe(epochBefore + 1);
  });

  it("强新 key → 200，落库并 bump token_epoch", async () => {
    const token = await makeToken();
    const epochBefore = await getTokenEpoch();
    const res = await patchHandler()(patchRequest({ newApiKey: STRONG_NEW }, token), {} as never);
    expect(res.status).toBe(200);
    expect(await getAdminApiKey()).toBe(STRONG_NEW);
    expect(await getTokenEpoch()).toBe(epochBefore + 1);
  });
});
