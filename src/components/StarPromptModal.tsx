"use client";

import { useCallback, useEffect, useState } from "react";
import ModalPortal from "./ModalPortal";
import { useBodyScrollLock } from "@/hooks/useBodyScrollLock";
import { useUiLocale } from "@/lib/client/locale";
import { apiFetch } from "@/lib/client/api-client";
import { REPO_URL } from "@/lib/project-meta";

// 首次使用提示：给仓库点 star。
// 状态落库（settings 表 star_prompt_dismissed，见 /api/admin/settings/star-prompt）——
// 换浏览器/清缓存不会重复弹。
// 退出路径故意收窄到「Star / No / 右上 ×」三个显式动作：不带 Esc、不带点遮罩——
// 这是「只提示一次」的弹窗，误触关掉就永久不会再出现，必须让人看清了再选。

const COPY = {
  zh: {
    title: "给仓库点个 star",
    body: [
      "让我知道你正在使用，给我一个 star。",
      "你的支持是我持续更新的动力！",
    ],
    hint: "只提示这一次。",
    star: "去 star",
    no: "不用了",
  },
  en: {
    title: "Star the repo",
    body: [
      "Let me know you're using it — a star would help.",
      "Your support is what keeps the updates coming!",
    ],
    hint: "Shown once.",
    star: "Star it",
    no: "No thanks",
  },
} as const;

export default function StarPromptModal() {
  const locale = useUiLocale();
  const [open, setOpen] = useState(false);

  // 读库里的提示状态：只有从未提示过才弹
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await apiFetch("/api/admin/settings/star-prompt");
        const json = await res.json();
        if (!cancelled && json.success && json.data.dismissed === false) {
          setOpen(true);
        }
      } catch {
        // 读不到就不弹（不因为网络抖动打扰用户）
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const dismiss = useCallback(() => {
    setOpen(false);
    // 落库失败也保持关闭（本次不打扰）；失败时下次刷新会再弹一次
    apiFetch("/api/admin/settings/star-prompt", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dismissed: true }),
    }).catch(() => {});
  }, []);

  useBodyScrollLock(open);

  // 语言要挂载后才能定（静态导出首帧在服务端），未定前不渲染避免文案闪变
  if (!open || !locale) return null;
  const copy = COPY[locale];

  return (
    <ModalPortal>
      <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
        {/* 移动端全屏、桌面居中卡片（与 ConfirmDialog 同形态） */}
        <div
          role="dialog"
          aria-modal="true"
          aria-labelledby="star-prompt-title"
          className="flex h-full w-full flex-col bg-white shadow-xl md:h-auto md:max-w-md md:rounded-lg"
        >
          <div className="flex items-center justify-between border-b px-5 py-3">
            <h3 id="star-prompt-title" className="font-semibold">
              {copy.title}
            </h3>
            <button
              type="button"
              onClick={dismiss}
              className="flex min-h-[40px] min-w-[40px] items-center justify-center text-2xl leading-none text-gray-400 hover:text-gray-600 md:min-h-0 md:min-w-0"
              aria-label="Close"
            >
              ×
            </button>
          </div>
          <div className="flex-1 overflow-y-auto overscroll-contain p-5 text-sm text-gray-700">
            {copy.body.map((line) => (
              <p key={line}>{line}</p>
            ))}
            <p className="mt-3 text-xs text-gray-400">{copy.hint}</p>
          </div>
          <div className="flex items-center justify-end gap-2 border-t px-5 py-3">
            <button
              type="button"
              onClick={dismiss}
              className="rounded border border-gray-300 px-4 py-2 text-sm text-gray-600 hover:bg-gray-50 min-h-[40px] md:min-h-0"
            >
              {copy.no}
            </button>
            <a
              href={REPO_URL}
              target="_blank"
              rel="noopener noreferrer"
              onClick={dismiss}
              className="inline-flex min-h-[40px] items-center rounded bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 md:min-h-0"
            >
              {copy.star}
            </a>
          </div>
        </div>
      </div>
    </ModalPortal>
  );
}
