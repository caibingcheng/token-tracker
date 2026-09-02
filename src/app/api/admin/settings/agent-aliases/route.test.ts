import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET, PUT } from "./route";
import {
  db,
  initDatabase,
  tokenRecords,
} from "@/lib/db";
import {
  setAdminApiKey,
  getTokenEpoch,
  deleteSetting,
  loadAgentAliases,
} from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-agent-aliases-route-"));
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
  await initDatabase();
  await withSkipCache(async () => {
    await db.delete(tokenRecords);
  });
  await deleteSetting("token_epoch").catch(() => {});
  await deleteSetting("agent_aliases").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, method: string, token?: string, body?: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method,
    headers: { "content-type": "application/json", "x-api-key": token ?? "" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("/api/admin/settings/agent-aliases 管理 API", () => {
  it("未认证 401", async () => {
    const res = await GET(req("/api/admin/settings/agent-aliases", "GET"));
    expect(res.status).toBe(401);
    const putRes = await PUT(req("/api/admin/settings/agent-aliases", "PUT"));
    expect(putRes.status).toBe(401);
  });

  it("GET 默认返回空数组", async () => {
    const token = await makeToken();
    const res = await GET(req("/api/admin/settings/agent-aliases", "GET", token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual([]);
  });

  it("PUT 非法规则 400", async () => {
    const token = await makeToken();
    const res = await PUT(
      req("/api/admin/settings/agent-aliases", "PUT", token, {
        rules: [{ name: "", aliases: ["codex"] }],
      })
    );
    expect(res.status).toBe(400);
    const res2 = await PUT(
      req("/api/admin/settings/agent-aliases", "PUT", token, {
        rules: [{ name: "Codex", aliases: "codex" }],
      })
    );
    expect(res2.status).toBe(400);
    const res3 = await PUT(
      req("/api/admin/settings/agent-aliases", "PUT", token, {
        rules: [{ name: "Codex", aliases: ["codex"], extra: 1 }],
      })
    );
    expect(res3.status).toBe(400);
  });

  it("PUT 保存后 GET 立即可读（withSkipCache），且 loadAgentAliases 同源读取", async () => {
    const token = await makeToken();
    const rules = [
      { name: "Codex", aliases: ["codex", "codex_cli_rs"] },
      { name: "Claude Code", aliases: ["claude-cli"] },
    ];
    const res = await PUT(
      req("/api/admin/settings/agent-aliases", "PUT", token, { rules })
    );
    expect(res.status).toBe(200);
    const getRes = await GET(req("/api/admin/settings/agent-aliases", "GET", token));
    const json = await getRes.json();
    expect(json.data).toEqual(rules);
    expect(await loadAgentAliases()).toEqual(rules);
  });
});