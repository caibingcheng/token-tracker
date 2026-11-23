// next build（output: 'export'）产物 out/ 的静态托管。
// 页面导出形态是 `/admin` → out/admin.html（无 trailingSlash），候选序：
//   有扩展名 → 原路径；无扩展名 → [原路径, 原路径.html, 原路径/index.html]；根 → index.html
// 未命中返回原路径交给 serveStatic：其 stat 失败会走 next()，最终落到 app.notFound。
// 防穿越由 serveStatic 先行保证：它对（decode 后的）请求路径拒绝任何 .. 段，rewrite 输入已干净。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";

export const STATIC_ROOT = "out"; // 相对 cwd（Docker WORKDIR /app、dev/e2e 均在仓库根）

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

export function resolveExportPath(filename: string): string {
  const trimmed = filename.replace(/\/+$/, "");
  const rel = trimmed.replace(/^\//, "");
  // 候选序：原路径（含扩展名的文件、目录）→ <path>.html（Next export 的页面形态）→ <path>/index.html
  const candidates = rel === "" ? ["index.html"] : [rel, `${rel}.html`, `${rel}/index.html`];
  for (const candidate of candidates) {
    if (isFile(join(STATIC_ROOT, candidate))) return "/" + candidate;
  }
  return filename;
}

// 404 壳启动时读一次缓存；构建产物缺失（如裸跑 dev API）时退化为纯文本
let notFoundHtml: string | null | undefined;
export function notFound(c: Context): Response {
  if (notFoundHtml === undefined) {
    try {
      notFoundHtml = readFileSync(join(STATIC_ROOT, "404.html"), "utf8");
    } catch {
      notFoundHtml = null;
    }
  }
  if (notFoundHtml !== null) return c.html(notFoundHtml, 404);
  return c.text("Not Found", 404);
}
