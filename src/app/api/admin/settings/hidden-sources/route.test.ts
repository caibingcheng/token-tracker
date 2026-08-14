import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET as agentsGET } from "@/app/api/agents/route";
import { GET as providersGET } from "@/app/api/providers/route";
import { GET as modelsGET } from "@/app/api/models/route";
import { GET as hsGET, PUT as hsPUT } from "./route";
import { DELETE as upstreamDelete } from "@/app/api/admin/upstreams/[id]/route";
import { DELETE as vkDelete } from "@/app/api/admin/virtual-keys/[id]/route";
import {
  db,
  initDatabase,
  tokenRecords,
  upstreamsTable,
  virtualKeysTable,
  upstreamKeysTable,
} from "@/lib/db";
import {
  setAdminApiKey,
  getTokenEpoch,
  deleteSetting,
  loadHiddenSources,
  setHiddenSourcesSetting,
} from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";
import { executeStatsQuery } from "@/lib/stats-query";
import { queryLatencyStats } from "@/lib/latency-query";
import {
  getCachedStatusData,
  setCachedStatusData,
} from "@/lib/status-query";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-hidden-sources-route-"));
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
    await db.delete(upstreamKeysTable);
    await db.delete(upstreamsTable);
    await db.delete(virtualKeysTable);
  });
  await deleteSetting("token_epoch").catch(() => {});
  await deleteSetting("hidden_sources").catch(() => {});
  await deleteSetting("hidden_providers").catch(() => {});
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

interface RecordInput {
  model: string;
  provider: string;
  agent: string;
  i?: number;
  o?: number;
  createdAt?: string;
  ttftMs?: number | null;
  latencyMs?: number | null;
}

async function insertRecord(r: RecordInput): Promise<void> {
  await withSkipCache(async () => {
    await db.insert(tokenRecords).values({
      model: r.model,
      provider: r.provider,
      agent: r.agent,
      inputTokens: r.i ?? 100,
      outputTokens: r.o ?? 50,
      cacheRead: 0,
      cacheWrite: 0,
      ttftMs: r.ttftMs ?? null,
      latencyMs: r.latencyMs ?? null,
      createdAt: r.createdAt ?? new Date().toISOString(),
    });
  });
}

async function insertUpstream(name: string, models: string[]): Promise<number> {
  return withSkipCache(async () => {
    const row = await db
      .insert(upstreamsTable)
      .values({
        name,
        protocol: "openai",
        baseUrl: "https://api.example.com",
        enabledModels: JSON.stringify(models),
        priority: 0,
        enabled: 1,
      })
      .returning();
    return row[0]!.id;
  });
}

async function insertVk(name: string): Promise<number> {
  return withSkipCache(async () => {
    const row = await db
      .insert(virtualKeysTable)
      .values({
        name,
        apiKeyEncrypted: encryptSecret("vk-test"),
        enabled: 1,
        enabledModels: '["*"]',
      })
      .returning();
    return row[0]!.id;
  });
}

async function saveConfig(cfg: {
  upstreams?: string[];
  virtualKeys?: string[];
  excludedUpstreams?: string[];
  excludedVirtualKeys?: string[];
}): Promise<void> {
  await setHiddenSourcesSetting({
    upstreams: cfg.upstreams ?? [],
    virtualKeys: cfg.virtualKeys ?? [],
    excludedUpstreams: cfg.excludedUpstreams ?? [],
    excludedVirtualKeys: cfg.excludedVirtualKeys ?? [],
  });
}

describe("/api/admin/settings/hidden-sources 管理 API", () => {
  it("未认证 401", async () => {
    const res = await hsGET(req("/api/admin/settings/hidden-sources", "GET"));
    expect(res.status).toBe(401);
    const putRes = await hsPUT(req("/api/admin/settings/hidden-sources", "PUT"));
    expect(putRes.status).toBe(401);
  });

  it("GET 默认返回空配置", async () => {
    const token = await makeToken();
    const res = await hsGET(req("/api/admin/settings/hidden-sources", "GET", token));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.config).toEqual({
      upstreams: [],
      virtualKeys: [],
      excludedUpstreams: [],
      excludedVirtualKeys: [],
    });
  });

  it("PUT 非法配置 400", async () => {
    const token = await makeToken();
    const res = await hsPUT(
      req("/api/admin/settings/hidden-sources", "PUT", token, {
        config: { upstreams: "not-array", virtualKeys: [], excludedUpstreams: [], excludedVirtualKeys: [] },
      })
    );
    expect(res.status).toBe(400);
  });

  it("PUT 保存后 GET 立即可读（withSkipCache）", async () => {
    const token = await makeToken();
    const cfg = {
      upstreams: ["deepseek"],
      virtualKeys: ["old-agent"],
      excludedUpstreams: ["openai"],
      excludedVirtualKeys: ["legacy-agent"],
    };
    const res = await hsPUT(
      req("/api/admin/settings/hidden-sources", "PUT", token, { config: cfg })
    );
    expect(res.status).toBe(200);
    const getRes = await hsGET(req("/api/admin/settings/hidden-sources", "GET", token));
    const json = await getRes.json();
    expect(json.data.config).toEqual(cfg);
  });
});

describe("stats-query 剔除（excluded 独立列表）", () => {
  beforeEach(async () => {
    await insertRecord({ model: "gpt-4o", provider: "openai", agent: "agent-a", i: 100 });
    await insertRecord({ model: "gpt-4o", provider: "openai", agent: "unknown", i: 200 });
    await insertRecord({ model: "deepseek-chat", provider: "deepseek", agent: "agent-b", i: 300 });
  });

  it("未配置（开关关）不过滤：全部计入", async () => {
    const data = (await executeStatsQuery({
      groupBy: "none",
      range: "all",
      provider: "all",
      model: "all",
      agentFilter: null,
    })) as Array<{ count: number; totalInput: number }>;
    expect(data[0]!.count).toBe(3);
    expect(data[0]!.totalInput).toBe(600);
  });

  it("excluded 列表：provider + agent 均被剔除，'unknown' 不受影响", async () => {
    await saveConfig({
      excludedUpstreams: ["openai"],
      excludedVirtualKeys: ["agent-a"],
    });
    const data = (await executeStatsQuery({
      groupBy: "none",
      range: "all",
      provider: "all",
      model: "all",
      agentFilter: null,
    })) as Array<{ count: number; totalInput: number }>;
    // 只剩 deepseek/agent-b 一行；openai 全部行被 provider 条件剔除
    expect(data[0]!.count).toBe(1);
    expect(data[0]!.totalInput).toBe(300);
  });

  it("只排除 agent：'unknown' 遗留记录自然保留", async () => {
    await saveConfig({ excludedVirtualKeys: ["agent-a"] });
    const data = (await executeStatsQuery({
      groupBy: "none",
      range: "all",
      provider: "all",
      model: "all",
      agentFilter: null,
    })) as Array<{ count: number; totalInput: number }>;
    // openai/unknown + deepseek/agent-b 保留
    expect(data[0]!.count).toBe(2);
    expect(data[0]!.totalInput).toBe(500);
  });

  it("只隐藏不排除：聚合统计不受影响（两维度独立）", async () => {
    await saveConfig({ upstreams: ["openai"], virtualKeys: ["agent-a"] });
    const data = (await executeStatsQuery({
      groupBy: "none",
      range: "all",
      provider: "all",
      model: "all",
      agentFilter: null,
    })) as Array<{ count: number }>;
    expect(data[0]!.count).toBe(3);
  });

  it("不隐藏但排除（剔除但没隐藏）：聚合统计剔除该源", async () => {
    await saveConfig({ excludedUpstreams: ["openai"] });
    const data = (await executeStatsQuery({
      groupBy: "none",
      range: "all",
      provider: "all",
      model: "all",
      agentFilter: null,
    })) as Array<{ count: number }>;
    // openai 的两行被剔除，只剩 deepseek/agent-b
    expect(data[0]!.count).toBe(1);
  });

  it("date-model 分组同样生效（5 处 buildWhereClause 全覆盖）", async () => {
    await saveConfig({ excludedUpstreams: ["openai"] });
    const data = (await executeStatsQuery({
      groupBy: "date-model",
      range: "all",
      provider: "all",
      model: "all",
      agentFilter: null,
      granularity: "day",
    })) as Array<{ model: string }>;
    expect(data).toHaveLength(1);
    expect(data[0]!.model).toBe("deepseek-chat");
  });
});

describe("latency-query 剔除", () => {
  beforeEach(async () => {
    await insertUpstream("openai-up", ["gpt-4o"]);
    await insertUpstream("deepseek-up", ["deepseek-chat"]);
    await insertRecord({
      model: "gpt-4o",
      provider: "openai",
      agent: "agent-a",
      ttftMs: 100,
      latencyMs: 500,
    });
    await insertRecord({
      model: "deepseek-chat",
      provider: "deepseek",
      agent: "agent-b",
      ttftMs: 200,
      latencyMs: 800,
    });
  });

  async function latencyCount(): Promise<number> {
    const result = await queryLatencyStats({
      range: "30d",
      providerFilter: null,
      modelFilter: null,
      agentFilter: null,
      timezoneOffsetMinutes: 0,
      groups: [],
      aliases: [],
    });
    return result.byModel.reduce((s, m) => s + m.count, 0);
  }

  it("未配置不过滤", async () => {
    expect(await latencyCount()).toBe(2);
  });

  it("排除 excluded upstream 的流式样本", async () => {
    await saveConfig({ excludedUpstreams: ["openai"] });
    expect(await latencyCount()).toBe(1);
  });

  it("只隐藏名字不排除延迟统计（两维度独立）", async () => {
    await saveConfig({ upstreams: ["openai"], virtualKeys: ["agent-a"] });
    expect(await latencyCount()).toBe(2);
  });
});

describe("agents/providers/models 过滤 + includeHidden", () => {
  beforeEach(async () => {
    await insertRecord({ model: "gpt-4o", provider: "openai", agent: "agent-a" });
    await insertRecord({ model: "gpt-4o", provider: "openai", agent: "unknown" });
    await insertRecord({ model: "deepseek-chat", provider: "deepseek", agent: "agent-b" });
  });

  it("/api/agents 始终过滤隐藏 vk（与排除状态无关）；'unknown' 显示 (unknown)", async () => {
    await saveConfig({ virtualKeys: ["agent-a"], excludedVirtualKeys: ["agent-a"] });
    const token = await makeToken();
    const res = await agentsGET(req("/api/agents", "GET", token));
    const json = await res.json();
    const names = json.data.map((a: { id: string; name: string }) => a.id);
    expect(names).not.toContain("agent-a");
    expect(names).toContain("agent-b");
    const unknown = json.data.find((a: { id: string }) => a.id === "unknown");
    expect(unknown.name).toBe("(unknown)");
  });

  it("/api/agents?includeHidden=1 返回全部（含隐藏 vk）", async () => {
    await saveConfig({ virtualKeys: ["agent-a"] });
    const token = await makeToken();
    const res = await agentsGET(req("/api/agents?includeHidden=1", "GET", token));
    const json = await res.json();
    const names = json.data.map((a: { id: string }) => a.id);
    expect(names).toContain("agent-a");
    expect(names).toContain("agent-b");
  });

  it("/api/providers 在匿名化前按真实名排除隐藏 upstream", async () => {
    await saveConfig({ upstreams: ["openai"] });
    const { setSetting } = await import("@/lib/auth/settings");
    await setSetting("hidden_providers", "openai");
    const token = await makeToken();
    const res = await providersGET(req("/api/providers", "GET", token));
    const json = await res.json();
    const names = json.data.map((p: { id: string }) => p.id);
    expect(names).not.toContain("Provider A");
    expect(names).toContain("deepseek");
  });

  it("/api/providers?includeHidden=1 跳过过滤且跳过匿名化返回真实名", async () => {
    await saveConfig({ upstreams: ["openai"] });
    const { setSetting } = await import("@/lib/auth/settings");
    await setSetting("hidden_providers", "openai");
    const token = await makeToken();
    const res = await providersGET(req("/api/providers?includeHidden=1", "GET", token));
    const json = await res.json();
    const names = json.data.map((p: { id: string }) => p.id);
    expect(names).toContain("openai");
    expect(names).toContain("deepseek");
    expect(names).not.toContain("Provider A");
  });

  it("/api/models 行级过滤：隐藏 upstream/vk 的独有 model 一并消失", async () => {
    await saveConfig({ upstreams: ["openai"], virtualKeys: ["agent-a"] });
    const token = await makeToken();
    const res = await modelsGET(req("/api/models", "GET", token));
    const json = await res.json();
    const ids = json.data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(["deepseek-chat"]);
  });

  it("/api/models?includeHidden=1 返回全部 model", async () => {
    await saveConfig({ upstreams: ["openai"], virtualKeys: ["agent-a"] });
    const token = await makeToken();
    const res = await modelsGET(req("/api/models?includeHidden=1", "GET", token));
    const json = await res.json();
    const ids = json.data.map((m: { id: string }) => m.id);
    expect(ids).toEqual(["deepseek-chat", "gpt-4o"]);
  });
});

describe("status 缓存失效", () => {
  it("setHiddenSourcesSetting 主动 invalidateStatusCache", async () => {
    setCachedStatusData("0", { timezoneOffsetMinutes: 0 } as never);
    expect(getCachedStatusData("0")).toBeDefined();
    await saveConfig({ upstreams: ["openai"] });
    expect(getCachedStatusData("0")).toBeUndefined();
  });
});

describe("删除路由 hideHistory 联动", () => {
  it("DELETE upstream ?hideHistory=1 追加名字进 hidden_sources", async () => {
    const id = await insertUpstream("doomed-up", ["gpt-4o"]);
    const token = await makeToken();
    const res = await upstreamDelete(
      req(`/api/admin/upstreams/${id}?hideHistory=1`, "DELETE", token),
      { params: { id: String(id) } }
    );
    expect(res.status).toBe(200);
    const cfg = await loadHiddenSources();
    expect(cfg.upstreams).toContain("doomed-up");
  });

  it("DELETE upstream 不带参数不联动", async () => {
    const id = await insertUpstream("normal-up", ["gpt-4o"]);
    const token = await makeToken();
    const res = await upstreamDelete(
      req(`/api/admin/upstreams/${id}`, "DELETE", token),
      { params: { id: String(id) } }
    );
    expect(res.status).toBe(200);
    const cfg = await loadHiddenSources();
    expect(cfg.upstreams).toEqual([]);
  });

  it("DELETE virtual-key ?hideHistory=1 追加名字进 hidden_sources", async () => {
    const id = await insertVk("doomed-vk");
    const token = await makeToken();
    const res = await vkDelete(
      req(`/api/admin/virtual-keys/${id}?hideHistory=1`, "DELETE", token),
      { params: { id: String(id) } }
    );
    expect(res.status).toBe(200);
    const cfg = await loadHiddenSources();
    expect(cfg.virtualKeys).toContain("doomed-vk");
  });

  it("DELETE virtual-key 重复 hideHistory 幂等（不重复追加）", async () => {
    const id = await insertVk("doomed-vk2");
    const token = await makeToken();
    await vkDelete(req(`/api/admin/virtual-keys/${id}?hideHistory=1`, "DELETE", token), {
      params: { id: String(id) },
    });
    const id2 = await insertVk("doomed-vk2");
    await vkDelete(req(`/api/admin/virtual-keys/${id2}?hideHistory=1`, "DELETE", token), {
      params: { id: String(id2) },
    });
    const cfg = await loadHiddenSources();
    expect(cfg.virtualKeys.filter((n) => n === "doomed-vk2")).toHaveLength(1);
  });
});
