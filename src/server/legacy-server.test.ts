import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { spawnSync } from "child_process";

// 这个文件的存在意义只有一个：把「容器启动命令过时」从 Node 的 MODULE_NOT_FOUND 栈翻译成人话。
// 断言钉住它「装了但永远不跑」的配对关系 —— 若有人看到 /app/server.js 存在就把 CMD 改回
// `node server.js`，每个容器都会跑翻译器然后 exit 1（等于全站宕机），而 COPY 那条断言仍然绿。
const ROOT = process.cwd();
const DOCKERFILE = readFileSync(join(ROOT, "Dockerfile"), "utf8");

describe("legacy /app/server.js 报错翻译器", () => {
  it("Dockerfile 把它装成 /app/server.js", () => {
    expect(DOCKERFILE).toMatch(/^COPY --chown=node:node legacy-server\.js \/app\/server\.js$/m);
  });

  it("CMD 仍指向 build/server.js，不指向翻译器", () => {
    expect(DOCKERFILE).toMatch(/^CMD \["node", "--optimize-for-size", "build\/server\.js"\]$/m);
  });

  it("执行时失败退出，并把新入口与自查命令写进 stderr", () => {
    const result = spawnSync(process.execPath, [join(ROOT, "legacy-server.js")], { encoding: "utf8" });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("build/server.js");
    expect(result.stderr).toContain("docker inspect");
  });
});
