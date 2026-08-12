import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET } from "./route";
import { db, initDatabase, modelPricesTable } from "@/lib/db";
import {
  setAdminApiKey,
  getTokenEpoch,
  deleteSetting,
} from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { withSkipCache } from "@/lib/db/cache";
import { resetSnapshotCache } from "@/lib/models-dev/snapshot";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;

const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

const SNAPSHOT = {
  // fetchedAt 取当前时间（age=0 < TTL），避免 getSnapshot 触发后台网络刷新
  fetchedAt: new Date().toISOString(),
  data: {
    anthropic: {
      id: "anthropic",
      name: "Anthropic",
      models: {
        "claude-sonnet-4-6": {
          id: "claude-sonnet-4-6",
          cost: { input: 3, output: 15, cache_read: 0.3 },
          last_updated: "2026-07-01",
        },
      },
    },
    openai: {
      id: "openai",
      name: "OpenAI",
      models: {
        "gpt-4o": {
          id: "gpt-4o",
          cost: { input: 2.5, output: 10 },
          last_updated: "2026-07-01",
        },
      },
    },
    meta: {
      id: "meta",
      name: "Meta",
      models: {
        "llama-4": {
          id: "llama-4",
          cost: { input: 1, output: 2 },
        },
      },
    },
  },
};

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-mpricing-route-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
  process.env.GATEWAY_SECRET = "0123456789abcdef0123456789abcdef";
  writeFileSync(
    join(dir, "models-dev-cache.json"),
    JSON.stringify(SNAPSHOT),
    "utf-8"
  );
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
    await db.delete(modelPricesTable);
  });
  await deleteSetting("token_epoch").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
  resetSnapshotCache();
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(url: string, token?: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    headers: {
      "x-api-key": token ?? "",
    },
  });
}

describe("GET /api/model-pricing", () => {
  it("无 search 参数：返回 model_prices 表已定价行 + providers 列表", async () => {
    await withSkipCache(async () => {
      await db.insert(modelPricesTable).values({
        model: "claude-sonnet-4-6",
        inputPrice: 3,
        outputPrice: 15,
        cacheReadPrice: 0.3,
        cacheWritePrice: 3,
        source: "manual",
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
    });

    const res = await GET(req("/api/model-pricing", await makeToken()));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([
      {
        canonicalId: "claude-sonnet-4-6",
        displayName: "claude-sonnet-4-6",
        inputPrice: 3,
        cacheReadPrice: 0.3,
        cacheWritePrice: 3,
        outputPrice: 15,
        // 归一化命中 models.dev 快照 → 推断出 provider 分组
        provider: "anthropic",
      },
    ]);
    expect(json.providers).toEqual([
      { id: "anthropic", name: "Anthropic" },
      { id: "meta", name: "Meta" },
      { id: "openai", name: "OpenAI" },
    ]);
  });

  it("无 search 参数：快照未命中的已定价模型不带 provider 字段", async () => {
    await withSkipCache(async () => {
      await db.insert(modelPricesTable).values({
        model: "my-custom-model",
        inputPrice: 1,
        outputPrice: 2,
        cacheReadPrice: 1,
        cacheWritePrice: 1,
        source: "manual",
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
    });

    const res = await GET(req("/api/model-pricing", await makeToken()));
    const json = await res.json();
    expect(json.data).toEqual([
      {
        canonicalId: "my-custom-model",
        displayName: "my-custom-model",
        inputPrice: 1,
        cacheReadPrice: 1,
        cacheWritePrice: 1,
        outputPrice: 2,
      },
    ]);
    // toEqual 忽略 undefined 属性，单独严格断言 provider 缺失
    expect(json.data[0].provider).toBeUndefined();
  });

  it("无 search 参数：日期变体已定价模型也能推断出 provider", async () => {
    await withSkipCache(async () => {
      await db.insert(modelPricesTable).values({
        model: "llama-4-20260101",
        inputPrice: 1,
        outputPrice: 2,
        cacheReadPrice: 1,
        cacheWritePrice: 1,
        source: "manual",
        updatedAt: "2026-08-01T00:00:00.000Z",
      });
    });

    const res = await GET(req("/api/model-pricing", await makeToken()));
    const json = await res.json();
    // 快照中无该日期变体 id → 剥离 -\d{8}$ 后命中 llama-4 的 key → 归 meta
    expect(json.data[0].provider).toBe("meta");
  });

  it("provider 参数：返回该 provider 的 models.dev 全部模型", async () => {
    const res = await GET(
      req("/api/model-pricing?provider=openai", await makeToken())
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toEqual({
      canonicalId: "openai/gpt-4o",
      displayName: "OpenAI · gpt-4o",
      inputPrice: 2.5,
      cacheReadPrice: 2.5,
      cacheWritePrice: 2.5,
      outputPrice: 10,
      provider: "openai",
    });
  });

  it("provider 参数：快照中不存在的 provider 返回空数组", async () => {
    const res = await GET(
      req("/api/model-pricing?provider=no-such-provider", await makeToken())
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("search 命中：返回 models.dev 快照条目，canonicalId = providerId/modelId，cache 缺失回退 input", async () => {
    const res = await GET(
      req("/api/model-pricing?search=claude", await makeToken())
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toEqual({
      canonicalId: "anthropic/claude-sonnet-4-6",
      displayName: "Anthropic · claude-sonnet-4-6",
      inputPrice: 3,
      cacheReadPrice: 0.3,
      cacheWritePrice: 3,
      outputPrice: 15,
      provider: "anthropic",
    });
  });

  it("search 命中 provider 名，无 cache 价时回退 input 价", async () => {
    const res = await GET(
      req("/api/model-pricing?search=openai", await makeToken())
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toHaveLength(1);
    expect(json.data[0]).toEqual({
      canonicalId: "openai/gpt-4o",
      displayName: "OpenAI · gpt-4o",
      inputPrice: 2.5,
      cacheReadPrice: 2.5,
      cacheWritePrice: 2.5,
      outputPrice: 10,
      provider: "openai",
    });
  });

  it("search 无结果：返回空数组", async () => {
    const res = await GET(
      req("/api/model-pricing?search=no-such-model-xyz", await makeToken())
    );
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data).toEqual([]);
  });

  it("未带会话 token：401", async () => {
    const res = await GET(req("/api/model-pricing"));
    expect(res.status).toBe(401);
  });
});
