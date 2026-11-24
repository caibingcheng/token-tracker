// next build（output: 'export'）产物 out/ 的静态托管。
// 页面导出形态是 `/admin` → out/admin.html（无 trailingSlash），候选序：
//   有扩展名 → 原路径；无扩展名 → [原路径, 原路径.html, 原路径/index.html]；根 → index.html
// 未命中返回原路径交给 serveStatic：其 stat 失败会走 next()，最终落到 app.notFound。
// 防穿越由 serveStatic 先行保证：它对（decode 后的）请求路径拒绝任何 .. 段，rewrite 输入已干净。
// 本文件的候选构造只用于 statSync 探测（不读内容），但仍按同一规则拒绝可疑路径，
// 避免探测越出 out/（命中也不影响服务结果，越界判断在 serveStatic 侧）。
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "hono";

export const STATIC_ROOT = "out"; // 相对 cwd（Docker WORKDIR /app、dev/e2e 均在仓库根）

// 与 @hono/node-server serveStatic 同口径：.. 段 / 单点段 / 双斜杠 / 反斜杠一律不参与解析
const UNSAFE_PATH = /(?:^|[/\\])\.{1,2}(?:$|[/\\])|[/\\]{2,}|\\/;

// 导出产物里不该按「页面」直出的条目：404 与 _not-found 是 404 壳（直链要 404 而不是 200），
// 裸 index 在 Next 文件路由下没有对应地址（`/` 已由 rel === "" 分支处理）
const NOT_A_PAGE = new Set(["404", "_not-found", "index"]);

export type ExportFile = { file: string; size: number; mtimeMs: number };

// 命中导出文件时返回改写路径 + 尺寸/mtime（static-cache 用它算弱 ETag，省一次 stat）
export function resolveExportFile(
  pathname: string,
  root: string = STATIC_ROOT
): ExportFile | null {
  if (pathname.includes("%") || UNSAFE_PATH.test(pathname)) return null;
  const rel = pathname.replace(/\/+$/, "").replace(/^\//, "");
  if (rel === "") return statFile(root, "index.html");
  if (NOT_A_PAGE.has(rel) || rel.endsWith("/index")) return null;
  // 候选序：原路径（含扩展名的文件、目录）→ <path>.html（Next export 的页面形态）→ <path>/index.html
  for (const candidate of [rel, `${rel}.html`, `${rel}/index.html`]) {
    const found = statFile(root, candidate);
    if (found) return found;
  }
  return null;
}

function statFile(root: string, candidate: string): ExportFile | null {
  try {
    const stats = statSync(join(root, candidate));
    if (!stats.isFile()) return null;
    return { file: "/" + candidate, size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

// serveStatic 的 rewriteRequestPath：命中返回导出文件路径，未命中原样返回（交给其 stat 失败 → next()）。
// 注意 `root` 是给测试注入用的：serveStatic 会把 `(filename, c)` 两参传入，直接把这个函数
// 当 rewriteRequestPath 传会让 root 收到 Context 对象（join 抛 500）——index.ts 用箭头包一层。
export function resolveExportPath(filename: string, root: string = STATIC_ROOT): string {
  return resolveExportFile(filename, root)?.file ?? filename;
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
