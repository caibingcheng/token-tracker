import { defineConfig, globalIgnores } from "eslint/config";
import nextCoreWebVitals from "eslint-config-next/core-web-vitals";
import nextTypescript from "eslint-config-next/typescript";

// Next 16 移除了 `next lint`（内置 lint 命令已废弃），改用 ESLint 9 flat config：
// `npm run lint` = `eslint .`，规则集由 eslint-config-next 16 的 flat 预设提供。
const eslintConfig = defineConfig([
  ...nextCoreWebVitals,
  ...nextTypescript,
  {
    rules: {
      // 存量代码（路由 handler 的 drizzle 行、测试桩、响应 JSON）大量使用 any，
      // 与升级前 ESLint 8 + next/core-web-vitals 基线的严格度保持一致：不作为错误
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // React Compiler 系列规则（eslint-plugin-react-hooks v7 新增）要求重写大量组件的
      // 副作用/data-loading 结构，与本次升级无关；显式关闭以保持升级前的 lint 基线
      "react-hooks/set-state-in-effect": "off",
      "react-hooks/refs": "off",
      "react-hooks/immutability": "off",
      "react-hooks/purity": "off",
    },
  },
  {
    // CJS 配置文件必须用 require
    files: ["*.config.js", "next.config.js"],
    rules: { "@typescript-eslint/no-require-imports": "off" },
  },
  globalIgnores([
    ".next/**",
    "node_modules/**",
    "public/**",
    "next-env.d.ts",
    "data/**",
    "scripts/**",
  ]),
]);

export default eslintConfig;
