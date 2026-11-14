"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// 弹层统一挂到 document.body：避免被页面里任何 position/filter/transform/overflow
// 祖先影响定位（fixed 只在没有 transform/filter/contain 祖先时才相对视口），
// 也避免与页面内 sticky/z-index 元素互相抢层。
export default function ModalPortal({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  if (!mounted) return null;
  return createPortal(children, document.body);
}
