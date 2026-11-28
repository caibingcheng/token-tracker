import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// 生成注册表的静态断言（不 import 它：routes.generated 会把全部 route 模块 + DB 拖进来）。
// 目的：把「每个 route 都必须有 405 兜底，且排在该 route 所有具体方法之后」「通配路由的裸前缀
// 必须先注册 404」钉成 CI 可失败的约束，而不是靠人记得改 codegen
// （Hono 按注册序匹配，兜底前置会吞掉正常方法，裸前缀后置会被 `*` 零段命中截走）。
const SOURCE = readFileSync(join(process.cwd(), "src/server/routes.generated.ts"), "utf8");

type Line = { index: number; pattern: string; method?: string; kind: "on" | "405" | "notFound" };

const LINES: Line[] = [];
for (const m of SOURCE.matchAll(/app\.on\("([A-Z]+)", "([^"]+)"/g))
  LINES.push({ index: m.index ?? -1, pattern: m[2], method: m[1], kind: "on" });
for (const m of SOURCE.matchAll(/app\.all\("([^"]+)", \(c\) => c\.body\(null, 405/g))
  LINES.push({ index: m.index ?? -1, pattern: m[1], kind: "405" });
for (const m of SOURCE.matchAll(/app\.all\("([^"]+)", \(c\) => c\.notFound\(\)\)/g))
  LINES.push({ index: m.index ?? -1, pattern: m[1], kind: "notFound" });

const ON = LINES.filter((l) => l.kind === "on");
const FALLBACK = LINES.filter((l) => l.kind === "405");
const BARE = LINES.filter((l) => l.kind === "notFound");

function allowMap(kind: "405"): Map<string, string> {
  const re = new RegExp(`app\\.all\\("([^"]+)", \\(c\\) => c\\.body\\(null, ${kind}, \\{ Allow: "([^"]+)" \\}\\)`, "g");
  return new Map([...SOURCE.matchAll(re)].map((m) => [m[1], m[2]]));
}

describe("routes.generated.ts（注册完整性）", () => {
  const patterns = new Set(ON.map((l) => l.pattern));

  it("每个 pattern 恰好一条 405 兜底，且没有多余兜底", () => {
    expect(patterns.size).toBeGreaterThan(0);
    for (const pattern of patterns) {
      expect(FALLBACK.filter((l) => l.pattern === pattern).length, pattern).toBe(1);
    }
    expect(FALLBACK.length).toBe(patterns.size);
  });

  it("405 兜底排在同一 pattern 的所有具体方法之后", () => {
    for (const fallback of FALLBACK) {
      const lastOn = Math.max(...ON.filter((l) => l.pattern === fallback.pattern).map((l) => l.index));
      expect(fallback.index, fallback.pattern).toBeGreaterThan(lastOn);
    }
  });

  it("通配路由的裸前缀先注册 404（任何方法都不落到 405/OPTIONS）", () => {
    const wildcards = [...patterns].filter((p) => p.endsWith("/*"));
    expect(wildcards.length).toBe(3); // /v1 /v1beta /raw
    for (const pattern of wildcards) {
      const bare = pattern.slice(0, -2);
      const bareLine = BARE.find((l) => l.pattern === bare);
      expect(bareLine, bare).toBeDefined();
      const firstWildcard = Math.min(...LINES.filter((l) => l.pattern === pattern).map((l) => l.index));
      expect(bareLine!.index, bare).toBeLessThan(firstWildcard);
      // 裸前缀不能再有 405/OPTIONS（会被 404 抢先，属于生成冗余）
      expect(FALLBACK.some((l) => l.pattern === bare), bare).toBe(false);
    }
    expect(BARE.map((l) => l.pattern).sort()).toEqual(["/raw", "/v1", "/v1beta"]);
  });

  it("静态子路径先于同层的动态段注册（否则 app.all(':id') 会把它吃成 405）", () => {
    // 回归：`[id]` 的 405 兜底是 `app.all(pattern)`，Hono 按注册序匹配 → 同段数的静态兄弟
    // （如 /api/admin/devices/stats vs /api/admin/devices/:id）必须先注册，否则浏览器拿到
    // 405（Allow: PATCH, DELETE）。readdir 的字母序会把 `[` 排在字母前，所以 codegen
    // 必须显式排序（段数 → 静态 < 动态 < 通配）。
    const patterns = [...new Set(ON.map((l) => l.pattern))];
    const firstIndex = (pattern: string) =>
      Math.min(...ON.filter((l) => l.pattern === pattern).map((l) => l.index));
    const isStatic = (segment: string) => !segment.startsWith(":") && segment !== "*";
    const violations: string[] = [];
    for (const a of patterns) {
      for (const b of patterns) {
        if (a === b) continue;
        const as = a.split("/");
        const bs = b.split("/");
        if (as.length !== bs.length) continue;
        let i = 0;
        while (i < as.length && as[i] === bs[i]) i++;
        if (i === as.length) continue;
        if (isStatic(as[i]!) && !isStatic(bs[i]!)) {
          if (firstIndex(a) > firstIndex(b)) violations.push(`${a} 必须排在 ${b} 之前`);
        }
      }
    }
    expect(violations).toEqual([]);
  });

  it("405 的 Allow 与 OPTIONS 的 Allow 一致，且覆盖该 pattern 实际注册的全部方法", () => {
    const optionsAllow = new Map(
      [...SOURCE.matchAll(/app\.on\("OPTIONS", "([^"]+)", \(c\) => c\.body\(null, 204, \{ Allow: "([^"]+)" \}\)/g)].map(
        (m) => [m[1], m[2]]
      )
    );
    const fallbackAllow = allowMap("405");

    expect(fallbackAllow.size).toBe(optionsAllow.size);
    for (const [pattern, allow] of optionsAllow) {
      expect(fallbackAllow.get(pattern), pattern).toBe(allow);
      const methods = allow.split(", ");
      expect(new Set(methods).size, pattern).toBe(methods.length);
      expect(methods.every((m) => /^[A-Z]+$/.test(m)), pattern).toBe(true);

      // Allow 不能漏掉实际注册过的方法（OPTIONS 自身在列表里，HEAD 由 GET 回退补齐）
      const registered = new Set(ON.filter((l) => l.pattern === pattern).map((l) => l.method));
      for (const method of registered) expect(methods, `${pattern} ${method}`).toContain(method);
      expect(methods).toContain("OPTIONS");
      if (registered.has("GET")) expect(methods, `${pattern} HEAD`).toContain("HEAD");
    }
  });
});
