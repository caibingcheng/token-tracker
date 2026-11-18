import { describe, it, expect } from "vitest";
import {
  parseFilterValues,
  FilterParamError,
  MAX_FILTER_VALUES,
} from "@/lib/filter-params";

function params(query: string): URLSearchParams {
  return new URLSearchParams(query);
}

describe("parseFilterValues（多值筛选参数）", () => {
  it("单值与多值都解析成数组", () => {
    expect(parseFilterValues(params("agent=opencode"), "agent")).toEqual(["opencode"]);
    expect(parseFilterValues(params("agent=a&agent=b&agent=c"), "agent")).toEqual([
      "a",
      "b",
      "c",
    ]);
  });

  it("缺省 / 空串 / all 视为不筛选", () => {
    expect(parseFilterValues(params(""), "agent")).toEqual([]);
    expect(parseFilterValues(params("agent="), "agent")).toEqual([]);
    expect(parseFilterValues(params("agent=all"), "agent")).toEqual([]);
  });

  it("重复值去重且保持首次出现顺序", () => {
    expect(parseFilterValues(params("agent=b&agent=a&agent=b"), "agent")).toEqual([
      "b",
      "a",
    ]);
  });

  it("超长值 → FilterParamError", () => {
    expect(() => parseFilterValues(params(`agent=${"x".repeat(129)}`), "agent")).toThrow(
      FilterParamError
    );
  });

  it("值数量超过上限 → FilterParamError", () => {
    const query = Array.from({ length: MAX_FILTER_VALUES + 1 }, (_, i) => `agent=a${i}`).join("&");
    expect(() => parseFilterValues(params(query), "agent")).toThrow(FilterParamError);
  });
});
