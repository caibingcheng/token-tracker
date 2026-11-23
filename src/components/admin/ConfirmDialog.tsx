"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import ModalPortal from "@/components/ModalPortal";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { useModalDismiss } from "@/hooks/useModalDismiss";

export type ConfirmTone = "danger" | "warning" | "primary";

export interface ConfirmOptions {
  title: string;
  /** 后果说明：用 <ul>/<code> 列出受影响对象与不可逆点，不要写成一句泛泛的 "Are you sure?" */
  message: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
}

// 确认按钮配色：danger=删除类不可逆、warning=有代价但可逆（禁停/花费/覆盖）、primary=普通确认
const CONFIRM_BUTTON: Record<ConfirmTone, string> = {
  danger: "bg-red-600 hover:bg-red-700",
  warning: "bg-amber-600 hover:bg-amber-700",
  primary: "bg-blue-600 hover:bg-blue-700",
};

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

// 二次确认弹窗，替代裸 window.confirm：后者样式与站点脱节、移动端不可定制文案长度。
// 用法：const [confirm, confirmDialog] = useConfirm();
//       if (!(await confirm({ ... }))) return;
//       ...在组件 return 里渲染 {confirmDialog}
export function useConfirm(): [(options: ConfirmOptions) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<ConfirmOptions | null>(null);
  // resolve 存在 ref 里：settle 只在事件回调里调用一次，不去 setState updater 里做副作用
  const resolveRef = useRef<((ok: boolean) => void) | null>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  const titleId = useId();

  // 弹窗内容在 ModalPortal 里首帧 mounted=false，effect 阶段 DOM 还不存在，
  // 所以用 callback ref 在节点挂载瞬间取焦点；identity 固定，不会每次重渲染都抢焦点
  const focusCancelRef = useCallback((el: HTMLButtonElement | null) => {
    el?.focus();
  }, []);

  const confirm = useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => {
        if (resolveRef.current) {
          // 重入（Enter 重复触发、双击）：旧调用按取消落定，否则它的 await 永久悬挂。
          // 重入时 activeElement 已在弹窗内，不覆盖焦点来源
          resolveRef.current(false);
        } else {
          restoreFocusRef.current = document.activeElement as HTMLElement | null;
        }
        resolveRef.current = resolve;
        setPending(options);
      }),
    []
  );

  const settle = useCallback((ok: boolean) => {
    resolveRef.current?.(ok);
    resolveRef.current = null;
    setPending(null);
  }, []);

  const open = pending !== null;
  useBodyScrollLock(open);
  const dismiss = useModalDismiss(open, () => settle(false));

  // 关闭/卸载时还原焦点，并保证 await 中的 promise 一定落定（卸载视为取消）
  useEffect(() => {
    if (!open) return;
    return () => {
      restoreFocusRef.current?.focus();
      restoreFocusRef.current = null;
      resolveRef.current?.(false);
      resolveRef.current = null;
    };
  }, [open]);

  // Esc 与 Tab 都走 document 捕获阶段：Esc 必须只关确认框（它可能叠在其它弹窗之上），
  // 所以用 stopImmediatePropagation——同节点同阶段的监听（MultiSelect 的捕获 Esc、
  // 下层弹窗 useModalDismiss 的冒泡 Esc）一并拦掉。useModalDismiss 在这里只用到遮罩
  // onMouseDown，其 Esc 部分在 open 期间永远不会触发。
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        settle(false);
        return;
      }
      if (event.key !== "Tab") return;
      // Tab 循环限制在卡片内，防止焦点漫游到被遮罩住的下层弹窗/页面
      const focusables = cardRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE);
      if (!focusables || focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement;
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => document.removeEventListener("keydown", onKeyDown, true);
  }, [open, settle]);

  const dialog = pending ? (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" {...dismiss}>
        {/* 移动端全屏、桌面居中卡片：与 UpstreamsPanel / VirtualKeysPanel 的删除弹窗同形态 */}
        <div
          ref={cardRef}
          role="dialog"
          aria-modal="true"
          aria-labelledby={titleId}
          className="flex h-full w-full flex-col bg-white shadow-xl md:h-auto md:max-w-md md:rounded-lg"
        >
          <div className="flex items-center justify-between border-b px-5 py-3">
            <h3 id={titleId} className="font-semibold">
              {pending.title}
            </h3>
            <button
              type="button"
              onClick={() => settle(false)}
              className="flex min-h-[40px] min-w-[40px] items-center justify-center text-2xl leading-none text-gray-400 hover:text-gray-600 md:min-h-0 md:min-w-0"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain p-5 text-sm text-gray-700">
            {pending.message}
          </div>
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
            <button
              type="button"
              ref={focusCancelRef}
              onClick={() => settle(false)}
              className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 min-h-[40px] md:min-h-0"
            >
              {pending.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="button"
              onClick={() => settle(true)}
              className={`rounded px-4 py-2 text-sm font-medium text-white min-h-[40px] md:min-h-0 ${
                CONFIRM_BUTTON[pending.tone ?? "danger"]
              }`}
            >
              {pending.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </ModalPortal>
  ) : null;

  return [confirm, dialog];
}
