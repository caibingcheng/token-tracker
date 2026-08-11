import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { NextRequest } from "next/server";
import { GET, POST, DELETE } from "./route";
import {
  setAdminApiKey,
  isTotpEnabled,
  getTotpSecret,
  getTokenEpoch,
  getSetting,
  deleteSetting,
  clearTotp,
} from "@/lib/auth/settings";
import { signSessionToken, keyFingerprint } from "@/lib/auth/session";
import { generateTotpCode } from "@/lib/auth/totp";
import { clearTotpFailures } from "@/lib/auth/totp-lock";
import {
  clearRecoveryCodes,
  clearRecoveryCodeReminder,
  setRecoveryCodeReminder,
  getRecoveryCodeReminder,
} from "@/lib/auth/recovery-codes";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;
const ORIG_SECRET = process.env.GATEWAY_SECRET;

const ADMIN_KEY = "test-admin-key-123456";

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-totp-route-"));
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
  await clearTotp().catch(() => {});
  await clearTotpFailures().catch(() => {});
  await clearRecoveryCodes().catch(() => {});
  await clearRecoveryCodeReminder().catch(() => {});
  await deleteSetting("totp_pending_secret").catch(() => {});
  await deleteSetting("token_epoch").catch(() => {});
  await setAdminApiKey(ADMIN_KEY);
});

async function makeToken(): Promise<string> {
  const epoch = await getTokenEpoch();
  return signSessionToken(epoch, keyFingerprint(ADMIN_KEY), 60_000);
}

function req(method: string, body?: unknown, token?: string): NextRequest {
  return new NextRequest("http://localhost/api/admin/auth/totp", {
    method,
    headers: {
      "content-type": "application/json",
      "x-api-key": token ?? "",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function json(res: Response) {
  return (await res.json()) as Record<string, any>;
}

// 首次启用 TOTP（用临时库跑通完整流程），返回动态码生成辅助
async function enableTotp(): Promise<() => string> {
  const token = await makeToken();
  const gen = await json(await POST(req("POST", {}, token), { params: {} }));
  const secret = gen.data.secret as string;
  const code = generateTotpCode(secret);
  const confirm = await json(
    await POST(req("POST", { code }, token), { params: {} })
  );
  expect(confirm.success).toBe(true);
  expect(confirm.data.totpEnabled).toBe(true);
  expect(confirm.data.recoveryCodes).toHaveLength(4);
  return () => generateTotpCode(secret);
}

describe("TOTP 换绑与 recovery codes 路由集成", () => {
  it("已启用 TOTP 时，无 currentCode 生成 pending → 400", async () => {
    await enableTotp();
    const token = await makeToken();
    const res = await json(await POST(req("POST", {}, token), { params: {} }));
    expect(res.success).toBe(false);
    expect(res.error).toBe("TOTP code required");
    expect(await getSetting("totp_pending_secret")).toBeNull();
  });

  it("换绑 currentCode 错误 → 400 且计入 totp_fail_count，不生成 pending", async () => {
    const codeFor = await enableTotp();
    const token = await makeToken();
    const wrong = codeFor() === "000000" ? "000001" : "000000";
    const res = await json(
      await POST(req("POST", { currentCode: wrong }, token), { params: {} })
    );
    expect(res.success).toBe(false);
    expect(res.error).toBe("Invalid TOTP code");
    expect(await getSetting("totp_pending_secret")).toBeNull();
    const { getTotpFailCount } = await import("@/lib/auth/totp-lock");
    expect(await getTotpFailCount()).toBe(1);
  });

  it("换绑 currentCode 正确 → 生成新 pending", async () => {
    const codeFor = await enableTotp();
    const token = await makeToken();
    const res = await json(
      await POST(req("POST", { currentCode: codeFor() }, token), { params: {} })
    );
    expect(res.success).toBe(true);
    expect(res.data.secret).toBeTruthy();
    expect(res.data.otpauthUri).toContain("otpauth://totp/");
    expect(await getSetting("totp_pending_secret")).not.toBeNull();
  });

  it("新码验证 → 换绑成功（totp_secret 被替换），token_epoch +1（仅换绑路径）", async () => {
    const codeFor = await enableTotp();
    const oldSecret = (await getTotpSecret())!;
    expect(oldSecret).toBeTruthy();
    const token = await makeToken();
    const epochBefore = await getTokenEpoch();

    // 生成新 pending
    const gen = await json(
      await POST(req("POST", { currentCode: codeFor() }, token), { params: {} })
    );
    const newSecret = gen.data.secret as string;
    expect(newSecret).not.toBe(oldSecret);

    // 提交新码
    const confirm = await json(
      await POST(req("POST", { code: generateTotpCode(newSecret) }, token), {
        params: {},
      })
    );
    expect(confirm.success).toBe(true);
    expect(confirm.data.recoveryCodes).toHaveLength(4);
    expect(await getTotpSecret()).toBe(newSecret);
    expect(await isTotpEnabled()).toBe(true);
    expect(await getTokenEpoch()).toBe(epochBefore + 1);
  });

  it("首次启用成功后 token_epoch 不变（不吊销会话），recovery codes 已生成", async () => {
    const token = await makeToken();
    const epochBefore = await getTokenEpoch();
    const gen = await json(await POST(req("POST", {}, token), { params: {} }));
    const secret = gen.data.secret as string;
    const confirm = await json(
      await POST(req("POST", { code: generateTotpCode(secret) }, token), {
        params: {},
      })
    );
    expect(confirm.success).toBe(true);
    expect(confirm.data.recoveryCodes).toHaveLength(4);
    expect(await getTokenEpoch()).toBe(epochBefore);
    expect(await getSetting("recovery_codes")).not.toBeNull();
  });

  it("解绑成功后 recovery_codes 与 reminder 标记被清除", async () => {
    const codeFor = await enableTotp();
    await setRecoveryCodeReminder();
    expect(await getRecoveryCodeReminder()).toBe(true);
    const token = await makeToken();
    const res = await json(
      await DELETE(req("DELETE", { code: codeFor() }, token), { params: {} })
    );
    expect(res.success).toBe(true);
    expect(res.data.totpEnabled).toBe(false);
    expect(await isTotpEnabled()).toBe(false);
    expect(await getTotpSecret()).toBeNull();
    expect(await getSetting("recovery_codes")).toBeNull();
    expect(await getRecoveryCodeReminder()).toBe(false);
  });

  it("GET 返回启用状态与 pending 标记", async () => {
    await enableTotp();
    const token = await makeToken();
    const res = await json(await GET(req("GET", undefined, token), { params: {} }));
    expect(res.success).toBe(true);
    expect(res.data.totpEnabled).toBe(true);
    expect(res.data.pendingSecret).toBe(false);
  });
});
