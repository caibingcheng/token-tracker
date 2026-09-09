import { describe, it, expect } from "vitest";
import {
  validateIngestPayload,
  isValidInstanceName,
  isValidInstanceUid,
  MAX_RECORDS_PER_BATCH,
  MAX_BODY_BYTES,
} from "./validate";

function validRecord(overrides: Record<string, unknown> = {}) {
  return {
    sourceRecordId: 1,
    model: "gpt-4o",
    provider: "openai",
    agent: "claude-code",
    inputTokens: 10,
    outputTokens: 5,
    cacheRead: 2,
    cacheWrite: 0,
    status: null,
    latencyMs: null,
    ttftMs: null,
    requestModel: null,
    userAgent: null,
    createdAt: "2026-09-01T10:00:00.000Z",
    ...overrides,
  };
}

const VALID_UID = "u-0123456789abcdef0123456789abcdef";

describe("isValidInstanceName", () => {
  it("accepts [a-z0-9-]{1,32}", () => {
    expect(isValidInstanceName("bing-mbp")).toBe(true);
    expect(isValidInstanceName("a")).toBe(true);
    expect(isValidInstanceName("a1-b2c3".repeat(3) + "-x9")).toBe(true);
  });

  it("rejects invalid names", () => {
    expect(isValidInstanceName("")).toBe(false);
    expect(isValidInstanceName("Bing")).toBe(false);
    expect(isValidInstanceName("bing_1")).toBe(false);
    expect(isValidInstanceName("with space")).toBe(false);
    expect(isValidInstanceName("x".repeat(33))).toBe(false);
    expect(isValidInstanceName("remote/")).toBe(false);
  });
});

describe("isValidInstanceUid", () => {
  it("accepts u- + 32 hex", () => {
    expect(isValidInstanceUid(VALID_UID)).toBe(true);
    expect(isValidInstanceUid("u-00000000000000000000000000000000")).toBe(true);
  });

  it("rejects invalid uids", () => {
    expect(isValidInstanceUid("")).toBe(false);
    expect(isValidInstanceUid("bing-mbp")).toBe(false);
    expect(isValidInstanceUid("U-0123456789abcdef0123456789abcdef")).toBe(false);
    expect(isValidInstanceUid(`u-${"z".repeat(32)}`)).toBe(false); // 非 hex
    expect(isValidInstanceUid(`u-${"a".repeat(31)}`)).toBe(false); // 长度不足
    expect(isValidInstanceUid(`u-${"a".repeat(33)}`)).toBe(false); // 长度超
    expect(isValidInstanceUid(`v-${"a".repeat(32)}`)).toBe(false); // 前缀错误
    expect(isValidInstanceUid("u-" + "a".repeat(32).toUpperCase())).toBe(false); // 大写
  });
});

describe("validateIngestPayload", () => {
  it("accepts a valid payload", () => {
    const result = validateIngestPayload({
      instanceUid: VALID_UID,
      instance: "bing-mbp",
      epoch: "abc123",
      records: [validRecord()],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.records).toHaveLength(1);
      expect(result.payload.skippedInvalid).toEqual([]);
      expect(result.payload.instanceUid).toBe(VALID_UID);
      expect(result.payload.records[0]).toMatchObject({
        sourceRecordId: 1,
        model: "gpt-4o",
        userAgent: null,
      });
    }
  });

  it("rejects missing/invalid instanceUid, instance and epoch (structural 400)", () => {
    expect(validateIngestPayload({ instance: "ok", epoch: "e", records: [] }).ok).toBe(false);
    expect(validateIngestPayload({ instanceUid: "bad", instance: "ok", epoch: "e", records: [] }).ok).toBe(false);
    expect(validateIngestPayload({ instanceUid: "u-" + "a".repeat(31), instance: "ok", epoch: "e", records: [] }).ok).toBe(false);
    expect(validateIngestPayload({ instanceUid: VALID_UID, epoch: "e", records: [] }).ok).toBe(false);
    expect(validateIngestPayload({ instanceUid: VALID_UID, instance: "BAD", epoch: "e", records: [] }).ok).toBe(false);
    expect(validateIngestPayload({ instanceUid: VALID_UID, instance: "ok", records: [] }).ok).toBe(false);
    expect(validateIngestPayload({ instanceUid: VALID_UID, instance: "ok", epoch: "", records: [] }).ok).toBe(false);
    expect(validateIngestPayload({ instanceUid: VALID_UID, instance: "ok", epoch: "e", records: "x" }).ok).toBe(false);
    expect(validateIngestPayload(null).ok).toBe(false);
    expect(validateIngestPayload("x").ok).toBe(false);
  });

  it("rejects batches over the limit", () => {
    const records = Array.from({ length: MAX_RECORDS_PER_BATCH + 1 }, (_, i) =>
      validRecord({ sourceRecordId: i + 1 })
    );
    expect(validateIngestPayload({ instanceUid: VALID_UID, instance: "ok", epoch: "e", records }).ok).toBe(false);
  });

  it("accepts empty records array", () => {
    const result = validateIngestPayload({ instanceUid: VALID_UID, instance: "ok", epoch: "e", records: [] });
    expect(result.ok).toBe(true);
  });

  it("skips invalid records individually (partial accept)", () => {
    const result = validateIngestPayload({
      instanceUid: VALID_UID,
      instance: "ok",
      epoch: "e",
      records: [
        validRecord({ sourceRecordId: 1 }),
        validRecord({ sourceRecordId: 2, inputTokens: -1 }), // 负数
        validRecord({ sourceRecordId: 3, createdAt: "not-a-date" }), // 非法 ISO
        validRecord({ sourceRecordId: 4, model: "x".repeat(257) }), // model 超长
        validRecord({ sourceRecordId: 5, cacheRead: Number.NaN }), // NaN
        validRecord({ sourceRecordId: 6, status: 123 }), // 类型错误
        "not-an-object", // 无法标识
        validRecord({ sourceRecordId: 0 }), // sourceRecordId 非正
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.records.map((r) => r.sourceRecordId)).toEqual([1]);
      expect(result.payload.skippedInvalid).toEqual([2, 3, 4, 5, 6, 0]);
    }
  });

  it("accepts large finite token values and truncates userAgent", () => {
    const result = validateIngestPayload({
      instanceUid: VALID_UID,
      instance: "ok",
      epoch: "e",
      records: [
        validRecord({
          inputTokens: 2 ** 40,
          userAgent: "u".repeat(600),
        }),
      ],
    });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.payload.records[0].inputTokens).toBe(2 ** 40);
      expect(result.payload.records[0].userAgent).toHaveLength(512);
    }
  });
});

describe("limits", () => {
  it("MAX_BODY_BYTES is 2MB", () => {
    expect(MAX_BODY_BYTES).toBe(2 * 1024 * 1024);
  });
});