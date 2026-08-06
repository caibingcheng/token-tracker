import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

// 统计口径测试：parsers 写库的 input_tokens 已统一为不含 cache_read，
// 展示层 Total Input 含 cache，因此聚合层 totalInput = SUM(input_tokens) + SUM(cache_read)。
// 通过静态断言防止回归：totalInput 不得被写成纯 SUM(input_tokens)，
// totalInputUncached 不得再被写成 SUM(input_tokens) - SUM(cache_read)。
const SOURCE = readFileSync(
  join(process.cwd(), "src/lib/stats-query.ts"),
  "utf8"
);

describe("stats-query aggregation semantics", () => {
  it("totalInput must be SUM(input_tokens) + SUM(cache_read) (cache included)", () => {
    // 必须存在含 cache 的汇总口径
    expect(SOURCE).toMatch(
      /SUM\(\$\{tokenRecords\.inputTokens\}\)\s*\+\s*SUM\(\$\{tokenRecords\.cacheRead\}\)/
    );
    // 每个 select 分支的 totalInput 都使用含 cache 公式
    const totalInputAssignments = SOURCE.match(
      /totalInput:\s*\n\s+sql<number>`SUM\(\$\{tokenRecords\.inputTokens\}\) \+ SUM\(\$\{tokenRecords\.cacheRead\}\)`,/g
    );
    expect(totalInputAssignments?.length).toBe(6);
  });

  it("totalInput must not regress to pure SUM(input_tokens) without cache_read", () => {
    // 不允许存在纯 SUM(input_tokens) 的 totalInput 赋值
    expect(SOURCE).not.toMatch(
      /totalInput:\s*\n\s+sql<number>`SUM\(\$\{tokenRecords\.inputTokens\}\)`,/g
    );
  });

  it("totalInputUncached must be SUM(input_tokens) without subtracting cache_read", () => {
    const uncachedAssignments = SOURCE.match(
      /totalInputUncached: sql<number>`SUM\(\$\{tokenRecords\.inputTokens\}\)`,/g
    );
    expect(uncachedAssignments?.length).toBe(6);
  });

  it("totalInputUncached must not regress to subtracting cache_read", () => {
    expect(SOURCE).not.toMatch(
      /totalInputUncached: sql<number>`SUM\(\$\{tokenRecords\.inputTokens\}\) - SUM\(\$\{tokenRecords\.cacheRead\}\)`,/g
    );
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
