// 中心（host）侧集成测试：**真实 HTTP 上游**（src/dev/fake-upstream）+ 真实 SQLite + createProxyDeps()。
// 与 proxy.test.ts 的分工：那边 mock fetch 钉协议分支与链组装，这里不 mock 任何东西，
// 钉「真实出站 → 上游真实响应 → usage 解析 → 落库」这条端到端链路。
// 覆盖：openai/anthropic/gemini 三协议（非流式 + 流式）、cache 命中字段、401 换 key、
// 跨 upstream failover、vk 模型白名单、上游 403 透传。
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { desc } from "drizzle-orm";
import {
  closeDb,
  db,
  initDatabase,
  tokenRecords,
  upstreamKeysTable,
  upstreamsTable,
  virtualKeysTable,
} from "@/lib/db";
import { withSkipCache } from "@/lib/db/cache";
import { encryptSecret } from "@/lib/gateway/crypto";
import { virtualKeyFingerprint } from "@/lib/gateway/vk-fingerprint";
import { handleProxyRequest } from "@/lib/gateway/proxy";
import { createProxyDeps } from "@/lib/gateway/proxy-deps";
import { createFakeUpstream } from "@/dev/fake-upstream/server";
import type { FakeUpstream } from "@/dev/fake-upstream/types";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;
const ORIG_PRIVATE = process.env.ALLOW_PRIVATE_UPSTREAMS;

const VK = "vk-fake-upstream-test";
let dir: string;
let fake: FakeUpstream;

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), "tt-fake-upstream-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  // upstream key / vk 都是 AES-256-GCM 存储；32 字节 hex 足够
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
  // fake 上游在环回地址上，必须打开 SSRF 逃生开关（与真实内网自建 LLM 同一路径）
  process.env.ALLOW_PRIVATE_UPSTREAMS = "true";

  fake = await createFakeUpstream({
    models: {
      "gpt-4o-mini": { protocol: "openai", promptTokens: 12, completionTokens: 8, cachedTokens: 5 },
      "gpt-4o": { protocol: "openai", promptTokens: 40, completionTokens: 20 },
      "claude-sonnet-4": { protocol: "anthropic", promptTokens: 24, completionTokens: 11, cachedTokens: 64 },
      "gemini-2.0-flash": { protocol: "gemini", promptTokens: 18, completionTokens: 9 },
    },
    keys: [
      { key: "sk-good" },
      { key: "sk-revoked", fail: { status: 401, message: "invalid api key" } },
      { key: "sk-limited", models: ["gpt-4o-mini"] },
    ],
  });
  await initDatabase();
});

afterAll(async () => {
  await fake?.close();
  closeDb();
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
  if (ORIG_SECRET === undefined) delete process.env.GATEWAY_SECRET;
  else process.env.GATEWAY_SECRET = ORIG_SECRET;
  if (ORIG_PRIVATE === undefined) delete process.env.ALLOW_PRIVATE_UPSTREAMS;
  else process.env.ALLOW_PRIVATE_UPSTREAMS = ORIG_PRIVATE;
});

beforeEach(async () => {
  fake.reset();
  await withSkipCache(async () => {
    await db.delete(tokenRecords);
    await db.delete(upstreamsTable); // upstream_keys 走 cascade
    await db.delete(virtualKeysTable);
  });
});

async function seedUpstream(opts: {
  name: string;
  protocol: "openai" | "anthropic" | "gemini";
  models: string[];
  keys: string[];
  priority?: number;
}): Promise<number> {
  return withSkipCache(async () => {
    const rows = await db
      .insert(upstreamsTable)
      .values({
        name: opts.name,
        protocol: opts.protocol,
        baseUrl: fake.url,
        enabledModels: JSON.stringify(opts.models),
        priority: opts.priority ?? 10,
        enabled: 1,
      })
      .returning({ id: upstreamsTable.id });
    const id = Number(rows[0]!.id);
    for (const key of opts.keys) {
      await db.insert(upstreamKeysTable).values({ upstreamId: id, apiKeyEncrypted: encryptSecret(key) });
    }
    return id;
  });
}

async function seedVirtualKey(enabledModels: string[] = ["*"]): Promise<void> {
  await withSkipCache(() =>
    db.insert(virtualKeysTable).values({
      name: "fake-test-vk",
      apiKeyEncrypted: encryptSecret(VK),
      keyFingerprint: virtualKeyFingerprint(VK),
      enabledModels: JSON.stringify(enabledModels),
    })
  );
}

function gateway(path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return handleProxyRequest(
    new Request(`http://localhost${path}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${VK}`,
        ...headers,
      },
      body: JSON.stringify(body),
    }),
    createProxyDeps()
  );
}

/** usage 落库可能是响应结束后的微任务（流式尤其），最多等 2s */
async function waitRecord(): Promise<typeof tokenRecords.$inferSelect> {
  for (let i = 0; i < 80; i++) {
    const rows = await withSkipCache(() =>
      db.select().from(tokenRecords).orderBy(desc(tokenRecords.id)).limit(1)
    );
    if (rows[0]) return rows[0]!;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("no token record written");
}

describe("host ⇄ fake upstream：三协议 usage 落库", () => {
  it("openai 非流式：透传响应 + input/output/cache 落库", async () => {
    await seedVirtualKey();
    await seedUpstream({ name: "fake-openai", protocol: "openai", models: ["gpt-4o-mini"], keys: ["sk-good"] });

    const res = await gateway("/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as any;
    expect(body.choices[0].message.content).toBe("fake upstream ok");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ protocol: "openai", key: "sk-good", model: "gpt-4o-mini" });

    const row = await waitRecord();
    // 口弸：input_tokens 不含 cache_read；OpenAI 的 prompt_tokens 是含 cache 的总量，
    // 所以这里 12 = 7(非缓存) + 5(命中缓存)，cache_read 单独成列。
    expect(row).toMatchObject({
      model: "gpt-4o-mini",
      requestModel: "gpt-4o-mini",
      provider: "fake-openai",
      inputTokens: 7,
      outputTokens: 8,
      cacheRead: 5,
    });
  });

  it("openai 流式：SSE 原样透传，末帧 usage 落库", async () => {
    await seedVirtualKey();
    await seedUpstream({ name: "fake-openai", protocol: "openai", models: ["gpt-4o-mini"], keys: ["sk-good"] });

    const res = await gateway("/v1/chat/completions", {
      model: "gpt-4o-mini",
      stream: true,
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("fake upstream ok");
    expect(text.trimEnd().endsWith("data: [DONE]")).toBe(true);

    const row = await waitRecord();
    expect(row).toMatchObject({ model: "gpt-4o-mini", inputTokens: 7, outputTokens: 8, cacheRead: 5 });
  });

  it("anthropic：cache_read_input_tokens → cache_read 列", async () => {
    await seedVirtualKey();
    await seedUpstream({
      name: "fake-anthropic",
      protocol: "anthropic",
      models: ["claude-sonnet-4"],
      keys: ["sk-good"],
    });

    const res = await gateway(
      "/v1/messages",
      { model: "claude-sonnet-4", max_tokens: 32, messages: [{ role: "user", content: "hi" }] },
      { "anthropic-version": "2023-06-01" }
    );
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ type: "message" });

    const row = await waitRecord();
    expect(row).toMatchObject({
      model: "claude-sonnet-4",
      inputTokens: 24,
      outputTokens: 11,
      cacheRead: 64,
    });
  });

  it("gemini：usageMetadata → input/output", async () => {
    await seedVirtualKey();
    await seedUpstream({
      name: "fake-gemini",
      protocol: "gemini",
      models: ["gemini-2.0-flash"],
      keys: ["sk-good"],
    });

    const res = await gateway("/v1beta/models/gemini-2.0-flash:generateContent", {
      contents: [{ parts: [{ text: "hi" }] }],
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as any).toMatchObject({ modelVersion: "gemini-2.0-flash" });

    const row = await waitRecord();
    expect(row).toMatchObject({ model: "gemini-2.0-flash", inputTokens: 18, outputTokens: 9, cacheRead: 0 });
  });
});

describe("host ⇄ fake upstream：故障转移", () => {
  it("同 upstream 的 401 key 自动换下一个 key", async () => {
    await seedVirtualKey();
    await seedUpstream({
      name: "fake-openai",
      protocol: "openai",
      models: ["gpt-4o-mini"],
      keys: ["sk-revoked", "sk-good"],
    });

    const res = await gateway("/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    // 第一次用坏 key 401，第二次换好 key 200
    expect(fake.requests.map((r) => [r.key, r.status])).toEqual([
      ["sk-revoked", 401],
      ["sk-good", 200],
    ]);
    expect((await waitRecord()).provider).toBe("fake-openai");
  });

  it("跨 upstream failover：坏 upstream 全 key 401 后换下一个", async () => {
    await seedVirtualKey();
    await seedUpstream({
      name: "fake-broken",
      protocol: "openai",
      models: ["gpt-4o-mini"],
      keys: ["sk-revoked"],
      priority: 1, // 先试
    });
    await seedUpstream({
      name: "fake-openai",
      protocol: "openai",
      models: ["gpt-4o-mini"],
      keys: ["sk-good"],
      priority: 10,
    });

    const res = await gateway("/v1/chat/completions", {
      model: "gpt-4o-mini",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(200);
    expect(fake.requests.every((r) => r.status === 401 || r.status === 200)).toBe(true);
    expect(fake.requests.at(-1)).toMatchObject({ key: "sk-good", status: 200 });
    // 记录归属最终成功的 upstream
    expect((await waitRecord()).provider).toBe("fake-openai");
  });

  it("上游 403（key 的 model 白名单）→ passthrough 透传，不当作中心拒绝", async () => {
    await seedVirtualKey();
    // 上游声明两个 model；key 只允许 gpt-4o-mini → 请求 gpt-4o 会被上游 403
    await seedUpstream({
      name: "fake-openai",
      protocol: "openai",
      models: ["gpt-4o-mini", "gpt-4o"],
      keys: ["sk-limited"],
    });

    const res = await gateway("/v1/chat/completions", {
      model: "gpt-4o",
      messages: [{ role: "user", content: "hi" }],
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.code).toBe("permission_denied");
    expect(fake.requests).toHaveLength(1);
    expect(fake.requests[0]).toMatchObject({ model: "gpt-4o", status: 403 });
  });
});

describe("host ⇄ fake upstream：中心侧校验（不打到上游）", () => {
  it("vk 的 enabled_models 不含该 model → 403 且上游零请求", async () => {
    await seedVirtualKey(["gpt-4o-mini"]);
    await seedUpstream({
      name: "fake-anthropic",
      protocol: "anthropic",
      models: ["claude-sonnet-4"],
      keys: ["sk-good"],
    });

    const res = await gateway("/v1/messages", { model: "claude-sonnet-4", messages: [] });
    expect(res.status).toBe(403);
    expect(((await res.json()) as any).error.type).toBe("model_not_allowed");
    expect(fake.requests).toHaveLength(0);
  });

  it("model 不存在于任何 upstream → 404 且上游零请求", async () => {
    await seedVirtualKey();
    await seedUpstream({ name: "fake-openai", protocol: "openai", models: ["gpt-4o-mini"], keys: ["sk-good"] });

    const res = await gateway("/v1/chat/completions", { model: "nope", messages: [] });
    expect(res.status).toBe(404);
    expect(fake.requests).toHaveLength(0);
  });
});
