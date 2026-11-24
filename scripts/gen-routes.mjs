#!/usr/bin/env node
// 路由注册表生成：扫 src/routes/**/route.ts，产出 src/server/routes.generated.ts。
// 规则与 Next 文件路由对齐：
//   [id]      → :id        （动态段）
//   [...path] → *          （通配段：Hono 不支持具名 `*path`，只认裸 `*`；Next 的
//                            params.path 是 segment 数组，dispatch 用 routePath 反推切分）
//   方法      → 文件里 export 的 GET/POST/...（含 withAuth(...) 赋值形式）；
//               有 GET 无 HEAD 时补 HEAD（Next 的 HEAD←GET 回退语义）
// 新增/移动/删除 route 后重跑；npm run dev / npm run build 会自动先跑本脚本。
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";

const ROOT = process.cwd();
const ROUTES_DIR = join(ROOT, "src", "routes");
const OUT_FILE = join(ROOT, "src", "server", "routes.generated.ts");
const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"];

function walk(dir) {
  const files = [];
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) files.push(...walk(full));
    else if (name === "route.ts") files.push(full);
  }
  return files.sort();
}

// api/admin/upstreams/[id] → /api/admin/upstreams/:id；[...path] → /*，同时收集通配段名
function toRoute(relDir) {
  const wildcardKeys = [];
  const segments = relDir.split("/").map((seg) => {
    const catchAll = /^\[\.\.\.(.+)\]$/.exec(seg);
    if (catchAll) {
      wildcardKeys.push(catchAll[1]);
      return "*";
    }
    const dynamic = /^\[(.+)\]$/.exec(seg);
    if (dynamic) return `:${dynamic[1]}`;
    return seg;
  });
  return { pattern: "/" + segments.join("/"), wildcardKeys };
}

// METHODS 之外的辅助：Allow 头的完整方法列表（含 HEAD 回退与 OPTIONS 自身）。
// OPTIONS 204 与 405 兜底共用同一份，避免两边漂移
function methodsWithHeadForAllow(exported) {
  const list = [...exported];
  if (exported.includes("GET") && !exported.includes("HEAD")) list.push("HEAD");
  list.push("OPTIONS");
  return list;
}

const routeFiles = walk(ROUTES_DIR);
if (routeFiles.length === 0) {
  console.error("gen-routes: src/routes 下没有 route.ts");
  process.exit(1);
}

const imports = [];
const registrations = [];

routeFiles.forEach((file, i) => {
  const rel = relative(ROUTES_DIR, file).replace(/\\/g, "/");
  const relDir = dirname(rel) === "." ? "" : dirname(rel).replace(/\\/g, "/");
  const content = readFileSync(file, "utf8");
  // 先剥注释再匹配：注释/字符串里形如 `export const GET` 的字样会误注册 undefined handler
  const scan = content.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");

  const exported = METHODS.filter((m) =>
    new RegExp(`export\\s+(?:const|async\\s+function|function)\\s+${m}\\b`).test(scan)
  );
  if (exported.length === 0) {
    console.error(`gen-routes: ${rel} 没有导出任何 HTTP 方法`);
    process.exit(1);
  }

  const { pattern, wildcardKeys } = toRoute(relDir);
  const wildcards = JSON.stringify(wildcardKeys);

  imports.push(`import * as m${i} from "@/routes/${relDir}/route";`);

  // 通配段的**零段**形态（`/v1`、`/raw` 裸前缀）在 Next 下是 404（`[...path]` 需至少一段），
  // 但 Hono 的 `*` 会零段命中。这里显式注册裸前缀并排在通配路由之前：任何方法
  //（含未实现方法与 OPTIONS）都统一 404，不会出现「GET /v1 → 404、DELETE /v1 → 405」的分裂。
  if (wildcardKeys.length > 0) {
    registrations.push(`  app.all("${pattern.slice(0, -2)}", (c) => c.notFound());`);
  }

  // 每个方法各自指向自己的 export；HEAD 无显式导出时回退到 GET（Next 同语义）
  const reg = (method, handler) =>
    `  app.on("${method}", "${pattern}", (c) => dispatch(m${i}.${handler}, c, ${wildcards}));`;
  for (const m of exported) registrations.push(reg(m, m));
  if (exported.includes("GET") && !exported.includes("HEAD")) registrations.push(reg("HEAD", "GET"));
  const allow = [...methodsWithHeadForAllow(exported)].join(", ");
  // OPTIONS 回补（Next 对未实现 OPTIONS 的路由自动 204 + Allow；同源前端不用，
  // 但第三方 SDK 的预检/探测会直接挂）；显式导出了 OPTIONS 就走上面的常规注册
  if (!exported.includes("OPTIONS")) {
    registrations.push(
      `  app.on("OPTIONS", "${pattern}", (c) => c.body(null, 204, { Allow: "${allow}" }));`
    );
  }
  // 405 兜底：Next 对「路径存在但方法未导出」返回 405 + Allow，Hono 的 app.on 只注册
  // 存在的方法，缺方法会一路落到静态 → notFound，变成 404 壳（语义退化，SDK 探测拿不到
  // Allow）。app.all 注册在本 route 的所有具体方法之后即兜底：具体方法先匹配即胜出。
  registrations.push(
    `  app.all("${pattern}", (c) => c.body(null, 405, { Allow: "${allow}" }));`
  );
});

const output = `// AUTO-GENERATED FILE — 由 scripts/gen-routes.mjs 生成，手改无效。
// 新增/移动/删除 src/routes/**/route.ts 后重跑：node scripts/gen-routes.mjs
import type { Hono } from "hono";
import { dispatch } from "./dispatch";

${imports.join("\n")}

export function registerRoutes(app: Hono): void {
${registrations.join("\n")}
}
`;

writeFileSync(OUT_FILE, output);
console.log(`gen-routes: ${routeFiles.length} 个 route → ${relative(ROOT, OUT_FILE)}`);
