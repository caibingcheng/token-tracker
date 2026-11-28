// relay 的两个版本号，语义不同：
// - RELAY_VERSION：wire 协议版本，中心用它做 426 版本协商（MIN_RELAY_VERSION），升协议才 bump；
// - RELAY_BUILD：发布版本，来自构建期的 git tag（CI 传 APP_VERSION），只用于展示；
//   esbuild define 注入；tsx/dev 环境没有 define，回落 "dev"。
// 不要把 build 版本拼进 plan 请求的 relayVersion：isVersionAtLeast 只认 3 段数字。
export const RELAY_VERSION = "1.0.0";

declare const __RELAY_APP_VERSION__: string | undefined;

export const RELAY_BUILD: string =
  typeof __RELAY_APP_VERSION__ === "string" && __RELAY_APP_VERSION__ !== ""
    ? __RELAY_APP_VERSION__
    : "dev";
