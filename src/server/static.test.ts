import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveExportFile, resolveExportPath } from "./static";

// 静态导出产物解析：与 out/ 的真实形态对齐（`/admin` → admin.html、RSC 侧 `admin.txt`）
let root: string;

function put(rel: string, body = "x") {
  const full = join(root, rel);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, body);
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tt-static-"));
  put("index.html");
  put("index.txt");
  put("admin.html");
  put("404.html");
  put("_not-found.html");
  put("manifest.webmanifest");
  put("admin/upstreams.html");
  put("admin/upstreams.txt");
  put("_next/static/chunks/a.js");
  put("admin/index.html");
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("resolveExportFile / resolveExportPath（out/ 路径解析）", () => {
  it("根路径 → index.html", () => {
    expect(resolveExportFile("/", root)?.file).toBe("/index.html");
    expect(resolveExportPath("/", root)).toBe("/index.html");
  });

  it("无扩展名页面 → <path>.html", () => {
    expect(resolveExportPath("/admin", root)).toBe("/admin.html");
    expect(resolveExportPath("/admin/", root)).toBe("/admin.html");
    expect(resolveExportPath("/admin/upstreams", root)).toBe("/admin/upstreams.html");
  });

  it("带扩展名的导出物（RSC payload / chunk / manifest）原样命中", () => {
    expect(resolveExportPath("/admin.txt", root)).toBe("/admin.txt");
    expect(resolveExportPath("/admin/upstreams.txt", root)).toBe("/admin/upstreams.txt");
    expect(resolveExportPath("/_next/static/chunks/a.js", root)).toBe("/_next/static/chunks/a.js");
    expect(resolveExportPath("/manifest.webmanifest", root)).toBe("/manifest.webmanifest");
  });

  it("返回 size/mtime 供协商缓存算 ETag", () => {
    const found = resolveExportFile("/admin", root);
    expect(found?.size).toBe(1);
    expect(found?.mtimeMs).toBeGreaterThan(0);
  });

  it("404 / _not-found / index 不按页面直出（直链要落到 notFound 的 404）", () => {
    expect(resolveExportFile("/404", root)).toBeNull();
    expect(resolveExportPath("/404", root)).toBe("/404");
    expect(resolveExportFile("/_not-found", root)).toBeNull();
    expect(resolveExportPath("/index", root)).toBe("/index");
    expect(resolveExportFile("/admin/index", root)).toBeNull();
  });

  it("未命中返回原路径（交给 serveStatic stat 失败 → next()）", () => {
    expect(resolveExportPath("/nope", root)).toBe("/nope");
    expect(resolveExportFile("/nope", root)).toBeNull();
  });

  it(".. 段 / 反斜杠 / 双斜杠 / 含 % 的路径不参与解析（防探测越出 out/）", () => {
    for (const bad of [
      "/../package.json",
      "/admin/../../package.json",
      "/..%2f..%2fetc/passwd",
      "/%2e%2e/package.json",
      "/a//b",
      "/a\\b",
      "/admin%20x",
    ]) {
      expect(resolveExportFile(bad, root)).toBeNull();
      expect(resolveExportPath(bad, root)).toBe(bad);
    }
  });
});
