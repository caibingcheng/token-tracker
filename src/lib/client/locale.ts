"use client";

import { useEffect, useState } from "react";

// 界面语言：只看浏览器本地时区偏移（getTimezoneOffset = UTC - 本地，分钟）。
// UTC+8 用中文，其余用英文 —— 不叠加 navigator.language 判定，避免同一时区里混排。

export type UiLocale = "zh" | "en";

export function localeFromOffsetMinutes(offsetMinutes: number): UiLocale {
  return offsetMinutes === -480 ? "zh" : "en";
}

export function getUiLocale(): UiLocale {
  if (typeof window === "undefined") return "en";
  return localeFromOffsetMinutes(new Date().getTimezoneOffset());
}

// 页面是静态导出（首帧由服务端渲染，拿不到本地时区），挂载后再定语言：
// 返回 null = 还没定，调用方先不渲染文案，避免英文闪一下再变中文 + hydration 不一致。
export function useUiLocale(): UiLocale | null {
  const [locale, setLocale] = useState<UiLocale | null>(null);
  useEffect(() => {
    setLocale(getUiLocale());
  }, []);
  return locale;
}
