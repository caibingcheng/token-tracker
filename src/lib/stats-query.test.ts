import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// 统计口径测试：parsers 写库的 input_tokens 已包含 cache_read（三协议 input 字段语义），
// 聚合层不能再加一次 SUM(cache_read)。通过静态断言防止回归双重计入。
const SOURCE = readFileSync(
  join(process.cwd(), "src/lib/stats-query.ts"),
  "utf8"
);

describe("stats-query aggregation semantics", () => {
  it("totalInput must be SUM(input_tokens) without adding cache_read", () => {
    // 不存在 "SUM(input) + SUM(cacheRead)" 双重计入
    expect(SOURCE).not.toMatch(
      /SUM\(\$\{tokenRecords\.inputTokens\}\)\s*\+\s*SUM\(\$\{tokenRecords\.cacheRead\}\)/
    );
    // 每个 select 分支都有 totalInput = SUM(inputTokens)
    const totalInputAssignments = SOURCE.match(
      /totalInput:\s*\n\s+sql<number>`SUM\(\$\{tokenRecords\.inputTokens\}\)`,/g
    );
    expect(totalInputAssignments?.length).toBe(6);
  });

  it("totalInputUncached must be SUM(input_tokens) - SUM(cache_read)", () => {
    const uncachedAssignments = SOURCE.match(
      /totalInputUncached: sql<number>`SUM\(\$\{tokenRecords\.inputTokens\}\) - SUM\(\$\{tokenRecords\.cacheRead\}\)`,/g
    );
    expect(uncachedAssignments?.length).toBe(6);
  });

  it("totalInputCached stays SUM(cache_read)", () => {
    const cachedAssignments = SOURCE.match(
      /totalInputCached: sql<number>`SUM\(\$\{tokenRecords\.cacheRead\}\)`,/g
    );
    expect(cachedAssignments?.length).toBe(6);
  });

  it("orderBy uses SUM(input_tokens) DESC without cache_read", () => {
    expect(SOURCE).not.toMatch(
      /SUM\(\$\{tokenRecords\.inputTokens\}\)\s*\+\s*SUM\(\$\{tokenRecords\.cacheRead\}\)\s*DESC/
    );
    const orderByAssignments = SOURCE.match(
      /sql`SUM\(\$\{tokenRecords\.inputTokens\}\) DESC`/g
    );
    expect(orderByAssignments?.length).toBe(3);
  });
});
