import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "fs";
import { join } from "path";

// route handler 在 src/routes（与 URL 路径镜像）；src/app 只剩静态导出的页面。
const API_DIR = join(process.cwd(), "src/routes/api");

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
    "src/routes/api/auth/login/route.ts",
    // 首次设置向导：fail-open 闸门自校验（DB 无 key AND env 无 key 才放行），
    // 未配置 key 时无法签发会话 token，只能走 setup 自身闸门
    "src/routes/api/auth/setup/route.ts",
    // 登出：无状态会话删 cookie 即结束，不要求携带有效 token（带了也可能刚过期）
    "src/routes/api/auth/logout/route.ts",
    // 公开用量快照：只返回全时段聚合 summary + today，无 provider/model/agent 维度；
    // 唯一参数 tzOffset，进程内 60s 快照限流，TTL 内不读库（见 route.ts 注释 + docs/agents/api-routes.md）
    "src/routes/api/cli/route.ts",
    // relay 配对：公开端点（无凭证），靠 8 位码 TTL + 限流 + clientSecret 自校验；
    // 码在 pair/start 时就绑死了 fingerprint + publicKey，单拿码换不到 token
    "src/routes/api/device/pair/start/route.ts",
    "src/routes/api/device/pair/poll/route.ts",
  ]);
  // device token（withDeviceAuth）保护的路由：不走 withAuth，但必须有 withDeviceAuth
  const deviceAuth = new Set([
    "src/routes/api/device/plan/route.ts",
    "src/routes/api/device/report/route.ts",
  ]);

  it("finds at least one API route", () => {
    expect(routeFiles.length).toBeGreaterThan(0);
  });

  it("every /api route handler must use withAuth (login excluded)", () => {
    const violations: string[] = [];
    for (const file of routeFiles) {
      // 统一成正斜杠：Windows 上 join() 产出反斜杠，exempt 用正斜杠登记
      const relative = file.slice(process.cwd().length + 1).replace(/\\/g, "/");
      if (exempt.has(relative) || deviceAuth.has(relative)) continue;
      const content = readFileSync(file, "utf8");
      if (!content.includes("withAuth")) {
        violations.push(relative);
      }
    }
    expect(violations).toEqual([]);
  });

  it("device token 路由必须被 withDeviceAuth 包裹", () => {
    for (const relative of deviceAuth) {
      const content = readFileSync(join(process.cwd(), relative), "utf8");
      expect(content, `${relative} 必须用 withDeviceAuth 包裹`).toContain("withDeviceAuth");
    }
  });

  it("device 下的每个路由要么公开例外、要么 withDeviceAuth、要么 withAuth（无漏网）", () => {
    const deviceDir = join(API_DIR, "device");
    const uncovered: string[] = [];
    for (const file of findRouteFiles(deviceDir)) {
      const relative = file.slice(process.cwd().length + 1).replace(/\\/g, "/");
      if (exempt.has(relative) || deviceAuth.has(relative)) continue;
      const content = readFileSync(file, "utf8");
      if (!content.includes("withAuth") && !content.includes("withDeviceAuth")) {
        uncovered.push(relative);
      }
    }
    expect(uncovered).toEqual([]);
  });

  it("pair/lookup 是会话态接口：用 withAuth，不得用 withDeviceAuth", () => {
    const content = readFileSync(
      join(process.cwd(), "src/routes/api/device/pair/lookup/route.ts"),
      "utf8"
    );
    expect(content).toContain("withAuth");
    // 只查「调用」，注释里提到该中间件不算违规
    expect(content).not.toMatch(/withDeviceAuth\s*\(/);
  });

  it("login route must not use withAuth (it accepts raw API key)", () => {
    const login = readFileSync(join(API_DIR, "auth/login/route.ts"), "utf8");
    expect(login).not.toContain("withAuth");
  });
});
