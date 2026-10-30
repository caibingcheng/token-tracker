// 登录 key 强度评估：仅作前端提示，不做任何强制（长度/类别均不拦截提交）。
// 纯函数模块，client 组件（setup / change key 表单提示）与 server 均可 import。
export type LoginKeyStrength = "weak" | "fair" | "strong";

const UPPER = /[A-Z]/;
const LOWER = /[a-z]/;
const DIGIT = /\d/;
const SYMBOL = /[^A-Za-z0-9]/;

// strong：≥16 字符且 ≥2 种类别；fair：8-15 字符且 ≥2 种类别；其余 weak
export function getLoginKeyStrength(key: string): LoginKeyStrength {
  const k = typeof key === "string" ? key.trim() : "";
  let classes = 0;
  if (UPPER.test(k)) classes++;
  if (LOWER.test(k)) classes++;
  if (DIGIT.test(k)) classes++;
  if (SYMBOL.test(k)) classes++;
  if (k.length >= 16 && classes >= 2) return "strong";
  if (k.length >= 8 && classes >= 2) return "fair";
  return "weak";
}

export const LOGIN_KEY_STRENGTH_META: Record<
  LoginKeyStrength,
  { label: string; className: string }
> = {
  weak: { label: "Weak", className: "text-red-600" },
  fair: { label: "Fair", className: "text-amber-600" },
  strong: { label: "Strong", className: "text-green-600" },
};
