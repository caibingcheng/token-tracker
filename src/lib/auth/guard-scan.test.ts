import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

const API_DIR = join(process.cwd(), "src/app/api");

function findRouteFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...findRouteFiles(full));
    } else if (entry === "route.ts") {
      files.push(full);
    }
  }
  return files;
}

describe("withAuth static scan (防漏保障第三层)", () => {
  const routeFiles = findRouteFiles(API_DIR);
  const exempt = new Set([
    // 登录接口：携带原始 API key，不走会话 token 认证
    "src/app/api/auth/login/route.ts",
  ]);

  it("finds at least one API route", () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  it("every /api route handler must use withAuth (login excluded)", () => {
    const violations: string[] = [];
    for (const file of routeFiles) {
      const relative = file.slice(process.cwd().length + 1);
      if (exempt.has(relative)) continue;
      const content = readFileSync(file, "utf8");
      if (!content.includes("withAuth")) {
        violations.push(relative);
      }
    }
    expect(violations).toEqual([]);
  });

  it("login route must not use withAuth (it accepts raw API key)", () => {
    const login = readFileSync(join(API_DIR, "auth/login/route.ts"), "utf8");
    expect(login).not.toContain("withAuth");
  });
});
