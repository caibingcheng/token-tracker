// plan 失败体解析：两种形状必须分开——业务错误 `{error:{message,type}}` vs
// device token 被拒 `{success:false,error:"..."}`（withDeviceAuth）。后者要能被识别出来
// 才能触发 relay 自愈（清 token + 重新配对），而不是永远给客户端一个 401 upstream_error。
import { describe, it, expect } from "vitest";
import { parsePlanFailure } from "./plan-client";

describe("parsePlanFailure", () => {
  it("device token 被拒（withDeviceAuth 形状）→ deviceTokenRejected", () => {
    const failure = parsePlanFailure(401, { success: false, error: "Invalid or revoked device token" });
    expect(failure.deviceTokenRejected).toBe(true);
    expect(failure.error.error.message).toBe("Invalid or revoked device token");
  });

  it("业务错误（planError 形状）→ 保留 type，不当作 token 被拒", () => {
    const failure = parsePlanFailure(401, { error: { message: "Invalid or revoked virtual key", type: "invalid_api_key" } });
    expect(failure.deviceTokenRejected).toBeUndefined();
    expect(failure.status).toBe(401);
    expect(failure.error.error).toEqual({ message: "Invalid or revoked virtual key", type: "invalid_api_key" });
  });

  it("非 401 的 success:false 不算 token 被拒（例如 400 invalid_request_error）", () => {
    const failure = parsePlanFailure(400, { success: false, error: "bad request" });
    expect(failure.deviceTokenRejected).toBeUndefined();
    expect(failure.error.error.message).toBe("bad request");
  });

  it("非 JSON / 空 body → 兜底文案与 upstream_error 类型", () => {
    const failure = parsePlanFailure(502, null);
    expect(failure.error.error).toEqual({ message: "plan failed", type: "upstream_error" });
  });
});
