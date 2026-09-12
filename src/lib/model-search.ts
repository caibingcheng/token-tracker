/**
 * 模型名模糊过滤（前端纯逻辑）。
 *
 * - 大小写不敏感
 * - 分隔符无关：查询词与模型名统一去除 `- _ . / :` 后比较，如 `claude37` 可命中 `claude-3.7-sonnet`
 * - 模糊匹配（fzf 式子序列）：查询词字符按序出现即可命中、无需连续，如 `gpto` 命中 `gpt-4o`、`cs` 命中 `claude-sonnet`
 * - 多关键词（空白分隔）AND 语义：每个词都必须命中，如 `openai gpt4o` 只命中同时含两者的条目
 * - 排序：连续子串命中优先于纯子序列命中，同级保持原始顺序
 * - 空白查询原样返回全量列表
 */

/** needle 是否为 haystack 的字符子序列（按序出现、无需连续）；两侧均按码点比较 */
function isSubsequence(needle: string, haystack: string): boolean {
  const chars = Array.from(needle);
  if (chars.length === 0) return true;
  let i = 0;
  for (const ch of haystack) {
    if (ch === chars[i]) i++;
    if (i === chars.length) return true;
  }
  return false;
}

export function filterModelsByQuery(models: string[], query: string): string[] {
  const terms = query
    .toLowerCase()
    .split(/\s+/)
    .map((t) => t.replace(/[-_./:]/g, ""))
    .filter(Boolean);
  if (terms.length === 0) return models;

  const scored: Array<{ model: string; index: number; score: number }> = [];
  models.forEach((model, index) => {
    const haystack = model.toLowerCase().replace(/[-_./:]/g, "");
    let score = 0;
    for (const term of terms) {
      if (haystack.includes(term)) {
        score += 2;
      } else if (isSubsequence(term, haystack)) {
        score += 1;
      } else {
        return; // 任一关键词未命中即排除（AND 语义）
      }
    }
    scored.push({ model, index, score });
  });

  // 连续子串命中优先；同级保持原始顺序（稳定）
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.map((s) => s.model);
}
