"use client";

import { useEffect } from "react";

// 弹层打开期间锁住背景滚动：移动端在弹层内滚到顶/底后继续滑动会“滚动链”到背后页面。
// 仅设 body.overflow=hidden 在 iOS Safari 上不可靠（页面照样能滑），还会在滚动位置 != 0 时
// 让 fixed 遮罩与视口错位；所以用「body 固定 + 负 top 偏移」这套标准做法保留滚动位置。
// 引用计数：嵌套/同时打开的弹层不会互相解锁。
let lockCount = 0;
let savedScrollY = 0;
let savedStyle: Record<string, string> | null = null;

const LOCKED_PROPS = ["position", "top", "left", "right", "width", "overflow"] as const;

function lockBody() {
  savedScrollY = window.scrollY;
  savedStyle = {};
  for (const prop of LOCKED_PROPS) {
    savedStyle[prop] = document.body.style[prop];
  }
  document.body.style.position = "fixed";
  document.body.style.top = `-${savedScrollY}px`;
  document.body.style.left = "0";
  document.body.style.right = "0";
  document.body.style.width = "100%";
  document.body.style.overflow = "hidden";
}

function unlockBody() {
  if (savedStyle) {
    for (const prop of LOCKED_PROPS) {
      document.body.style[prop] = savedStyle[prop];
    }
    savedStyle = null;
  }
  window.scrollTo(0, savedScrollY);
}

export function useBodyScrollLock(active: boolean) {
  useEffect(() => {
    if (!active) return;
    if (lockCount === 0) lockBody();
    lockCount += 1;
    return () => {
      lockCount -= 1;
      if (lockCount === 0) unlockBody();
    };
  }, [active]);
}
