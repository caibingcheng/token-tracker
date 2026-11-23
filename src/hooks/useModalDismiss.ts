"use client";

import { useEffect, type MouseEvent } from "react";

// 弹层统一的退出路径：Esc + 点击遮罩，二者与右上角 × 等价。
// 遮罩用 mousedown 而非 click：在卡片内按下、拖到遮罩上松手不应关闭（反之亦然）。
// 用法：返回值展开到遮罩 div 上，遮罩须是固定全屏层、卡片为其子元素。
export function useModalDismiss(open: boolean, onClose: () => void) {
  useDismissOnEscape(open, onClose);

  return {
    // 只有落在遮罩自身（而不是卡片内任意子元素）才关闭
    onMouseDown: (event: MouseEvent<HTMLDivElement>) => {
      if (event.target === event.currentTarget) onClose();
    },
  };
}

// 纯键盘退出路径：下拉菜单等非遮罩型浮层复用（外部点击由各自的 mousedown 监听负责）
export function useDismissOnEscape(open: boolean, onClose: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, onClose]);
}
