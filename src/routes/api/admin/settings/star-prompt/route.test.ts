import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET, PUT } from "./route";
import { closeDb, initDatabase } from "@/lib/db";
import {
  setAdminApiKey,
  getTokenEpoch,
  deleteSetting,
  getSetting,
} from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-star-prompt-route-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
});

afterAll(() => {
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
});

beforeEach(async () => {
  await initDatabase();
  await deleteSetting("token_epoch").catch(() => {});
  await deleteSetting("star_prompt_dismissed").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(method: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/settings/star-prompt", {
    method,
    headers: { "content-type": "application/json", "x-api-key": token ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/admin/settings/star-prompt", () => {
  it("未认证 401", async () => {
    expect((await GET(req("GET"))).status).toBe(401);
  });

  it("未提示过时 dismissed=false", async () => {
    const res = await GET(req("GET", await makeToken()));
    expect(res.status).toBe(200);
    expect((await res.json()).data.dismissed).toBe(false);
  });

  it("写 dismissed=true 后落库且回读为 true", async () => {
    const token = await makeToken();
    expect((await PUT(req("PUT", token, { dismissed: true }))).status).toBe(200);
    expect(await getSetting("star_prompt_dismissed")).toBe("1");
    expect((await (await GET(req("GET", token))).json()).data.dismissed).toBe(true);
  });

  it("只接受 dismissed=true（不可把已提示状态改回未提示）", async () => {
    const token = await makeToken();
    expect((await PUT(req("PUT", token, { dismissed: false }))).status).toBe(400);
    expect((await PUT(req("PUT", token, {}))).status).toBe(400);
  });
});
