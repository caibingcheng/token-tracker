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
import { DEFAULT_RECORD_COLUMNS } from "@/lib/records-columns";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-records-columns-route-"));
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
  await deleteSetting("records_columns").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(method: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest("http://localhost/api/admin/settings/records-columns", {
    method,
    headers: { "content-type": "application/json", "x-api-key": token ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/admin/settings/records-columns", () => {
  it("未认证 401", async () => {
    expect((await GET(req("GET"))).status).toBe(401);
    expect((await PUT(req("PUT", undefined, { columns: ["date"] }))).status).toBe(401);
  });

  it("GET 默认返回全列", async () => {
    const res = await GET(req("GET", await makeToken()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.columns).toEqual(DEFAULT_RECORD_COLUMNS);
  });

  it("PUT 落库后 GET 读回，且写入 settings 表明文 JSON", async () => {
    const token = await makeToken();
    const putRes = await PUT(req("PUT", token, { columns: ["latency", "model"] }));
    expect(putRes.status).toBe(200);

    expect(await getSetting("records_columns")).toBe('["latency","model"]');

    const json = await (await GET(req("GET", token))).json();
    // 返回按定义顺序归一后的结果
    expect(json.data.columns).toEqual(["model", "latency"]);
  });

  it("PUT 非法输入 400 且不改动已有配置", async () => {
    const token = await makeToken();
    await PUT(req("PUT", token, { columns: ["date"] }));

    for (const bad of [[], ["date", "date"], ["nope"], "date", null, 123]) {
      const res = await PUT(req("PUT", token, { columns: bad }));
      expect(res.status).toBe(400);
    }
    expect((await PUT(req("PUT", token, {}))).status).toBe(400);

    const json = await (await GET(req("GET", token))).json();
    expect(json.data.columns).toEqual(["date"]);
  });

  it("存量坏值（非法 JSON / 未知 id）读取回退默认", async () => {
    const token = await makeToken();
    const { setSetting } = await import("@/lib/auth/settings");

    await setSetting("records_columns", "oops");
    expect((await (await GET(req("GET", token))).json()).data.columns).toEqual(
      DEFAULT_RECORD_COLUMNS
    );

    await setSetting("records_columns", '["ghost"]');
    expect((await (await GET(req("GET", token))).json()).data.columns).toEqual(
      DEFAULT_RECORD_COLUMNS
    );
  });
});
