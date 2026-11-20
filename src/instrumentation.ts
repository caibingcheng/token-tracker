// Next.js instrumentation hook：Node.js 与 Edge 各编译一份，所以这里只做 runtime 分派。
//
// Node-only 逻辑（process.memoryUsage / setInterval.unref）必须放在单独模块里按
// process.env.NEXT_RUNTIME 条件加载：写在同一个文件里，Edge 编译会针对这些 Node API
// 报 “A Node.js API is used ... not supported in the Edge Runtime”，并在 dev 下每个请求
// 重复打印一次。分派放在 register 内部动态 import，Edge 编译时 NEXT_RUNTIME 被常量折叠
// 成 'edge'，函数提前 return，整个 import 分支会被摇掉。
//
// 正向匹配 'nodejs'（而非排除 'edge'）：新增 runtime 时默认不加载 Node-only 模块。

export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  const { registerNode } = await import("./instrumentation.node");
  registerNode();
}
