import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  generateRecoveryCodes,
  generateOneRecoveryCode,
  hashRecoveryCode,
  parseRecoveryCodeInput,
  classifySecondFactorInput,
  verifyRecoveryCode,
  getRemainingRecoveryCodes,
  hasRecoveryCodes,
  setRecoveryCodes,
  clearRecoveryCodes,
  getRecoveryCodeReminder,
  setRecoveryCodeReminder,
  clearRecoveryCodeReminder,
} from "./recovery-codes";

const ORIG_DB = process.env.SQLITE_DATABASE_PATH;

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "tt-recovery-codes-"));
  process.env.SQLITE_DATABASE_PATH = join(dir, "test.db");
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  if (ORIG_DB === undefined) delete process.env.SQLITE_DATABASE_PATH;
  else process.env.SQLITE_DATABASE_PATH = ORIG_DB;
});

beforeEach(async () => {
  await clearRecoveryCodes().catch(() => {});
  await clearRecoveryCodeReminder().catch(() => {});
});

describe("generateRecoveryCodes", () => {
  it("生成 4 个 XXXX-XXXX-XXXX-XXXX 格式的码", () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(4);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }
  });

  it("生成的码互不重复", () => {
    const codes = generateRecoveryCodes(4);
    expect(new Set(codes).size).toBe(4);
  });

  it("字符集不包含 0/O/I/1", () => {
    for (let i = 0; i < 20; i++) {
      const code = generateOneRecoveryCode();
      expect(code).not.toMatch(/[0OIl1]/);
    }
  });

  it("支持自定义数量", () => {
    expect(generateRecoveryCodes(8)).toHaveLength(8);
  });
});

describe("hashRecoveryCode", () => {
  it("确定性且输出 64 位 hex", () => {
    const code = "ABCD-EFGH-JKLM-NPQR";
    const h1 = hashRecoveryCode(code);
    const h2 = hashRecoveryCode(code);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("不同明文哈希不同", () => {
    expect(hashRecoveryCode("ABCD-EFGH-JKLM-NPQR")).not.toBe(
      hashRecoveryCode("ABCD-EFGH-JKLM-NPQX")
    );
  });
});

describe("parseRecoveryCodeInput", () => {
  it("归一化：小写、去连字符、去空格", () => {
    expect(parseRecoveryCodeInput("abcd-efgh-jklm-npqr")).toBe("ABCDEFGHJKLMNPQR");
    expect(parseRecoveryCodeInput(" ABCD-EFGH JKLM-NPQR ")).toBe("ABCDEFGHJKLMNPQR");
  });

  it("非法输入拒绝：长度不符、非法字符", () => {
    expect(parseRecoveryCodeInput("")).toBeNull();
    expect(parseRecoveryCodeInput("ABC")).toBeNull();
    expect(parseRecoveryCodeInput("ABCD-EFGH-JKLM-NPQR-X")).toBeNull();
    expect(parseRecoveryCodeInput("ABCD-EFGH-JKLM-NPQ0")).toBeNull(); // 含 0
    expect(parseRecoveryCodeInput("ABCD-EFGH-JKLM-NPQO")).toBeNull(); // 含 O
    expect(parseRecoveryCodeInput("ABCD-EFGH-JKLM-NPQ1")).toBeNull(); // 含 1
    expect(parseRecoveryCodeInput("ABCD-EFGH-JKLM-NPQI")).toBeNull(); // 含 I
    expect(parseRecoveryCodeInput("ABCD-EFGH-JKLM-NPQR!")).toBeNull();
  });
});

describe("classifySecondFactorInput", () => {
  it("6 位纯数字 → totp", () => {
    expect(classifySecondFactorInput("123456")).toBe("totp");
    expect(classifySecondFactorInput(" 000000 ")).toBe("totp");
  });

  it("合法 recovery 格式（含小写/无连字符/带空格变体）→ recovery", () => {
    expect(classifySecondFactorInput("ABCD-EFGH-JKLM-NPQR")).toBe("recovery");
    expect(classifySecondFactorInput("abcd-efgh-jklm-npqr")).toBe("recovery");
    expect(classifySecondFactorInput("ABCDEFGHJKLMNPQR")).toBe("recovery");
    expect(classifySecondFactorInput(" ABCD EFGH JKLM NPQR ")).toBe("recovery");
  });

  it("长度不符 / 非法字符 → invalid", () => {
    expect(classifySecondFactorInput("")).toBe("invalid");
    expect(classifySecondFactorInput("12345")).toBe("invalid");
    expect(classifySecondFactorInput("1234567")).toBe("invalid");
    expect(classifySecondFactorInput("ABCD-EFGH-JKLM-NPQ0")).toBe("invalid");
    expect(classifySecondFactorInput("abcdef")).toBe("invalid");
  });
});

describe("verifyRecoveryCode（真实 settings 存储）", () => {
  it("验证未使用码成功，标记已用后再次验证失败", async () => {
    const codes = generateRecoveryCodes(1);
    await setRecoveryCodes(codes);
    const code = codes[0]!;
    expect(await verifyRecoveryCode(code)).toBe(true);
    expect(await getRemainingRecoveryCodes()).toBe(0);
    expect(await verifyRecoveryCode(code)).toBe(false);
  });

  it("未使用码成功、已使用码失败、未存储时失败", async () => {
    const codes = generateRecoveryCodes(2);
    await setRecoveryCodes(codes);
    const [a, b] = [codes[0]!, codes[1]!];
    expect(await verifyRecoveryCode(a)).toBe(true);
    expect(await verifyRecoveryCode(a)).toBe(false);
    expect(await verifyRecoveryCode(b)).toBe(true);
    expect(await verifyRecoveryCode(generateOneRecoveryCode())).toBe(false);
  });

  it("输入归一化后仍可验证（小写/去连字符）", async () => {
    const codes = generateRecoveryCodes(1);
    await setRecoveryCodes(codes);
    const [code] = codes;
    const normalized = code.toLowerCase().replace(/-/g, "");
    expect(await verifyRecoveryCode(normalized)).toBe(true);
  });

  it("非法输入直接失败（不触碰存储）", async () => {
    expect(await verifyRecoveryCode("not-a-code")).toBe(false);
    expect(await getRemainingRecoveryCodes()).toBe(0);
  });
});

describe("remaining / has / reminder", () => {
  it("剩余数量递减正确", async () => {
    const codes = generateRecoveryCodes(4);
    await setRecoveryCodes(codes);
    expect(await getRemainingRecoveryCodes()).toBe(4);
    await verifyRecoveryCode(codes[0]!);
    await verifyRecoveryCode(codes[1]!);
    expect(await getRemainingRecoveryCodes()).toBe(2);
    await clearRecoveryCodes();
    expect(await getRemainingRecoveryCodes()).toBe(0);
    expect(await hasRecoveryCodes()).toBe(false);
  });

  it("setRecoveryCodes 后 hasRecoveryCodes 为 true，全用完后仍为 true（区分从未生成）", async () => {
    expect(await hasRecoveryCodes()).toBe(false);
    const [code] = generateRecoveryCodes(1);
    await setRecoveryCodes([code]);
    expect(await hasRecoveryCodes()).toBe(true);
    await verifyRecoveryCode(code);
    expect(await getRemainingRecoveryCodes()).toBe(0);
    expect(await hasRecoveryCodes()).toBe(true);
  });

  it("提醒标记 set/clear 往返", async () => {
    expect(await getRecoveryCodeReminder()).toBe(false);
    await setRecoveryCodeReminder();
    expect(await getRecoveryCodeReminder()).toBe(true);
    await clearRecoveryCodeReminder();
    expect(await getRecoveryCodeReminder()).toBe(false);
  });

  it("存储损坏（非法 JSON）时安全回退", async () => {
    const { setSetting } = await import("@/lib/auth/settings");
    await setSetting("recovery_codes", "{broken");
    expect(await getRemainingRecoveryCodes()).toBe(0);
    expect(await verifyRecoveryCode("ABCD-EFGH-JKLM-NPQR")).toBe(false);
  });
});
