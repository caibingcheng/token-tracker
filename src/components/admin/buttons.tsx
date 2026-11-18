// Admin 行内操作按钮统一样式。语义色固定：primary=蓝（Edit/Save 等主操作与
// 非破坏性动作）、danger=红（Delete 等破坏性动作）、warning=琥珀（解绑/跳过等
// 可逆但需留意的动作）、neutral=灰（Cancel/Test/Copy 等次要动作）。
// 形态规则：表格行（AdminTd 单元格内，仅桌面渲染）用 linkAction；卡片、表单流式
// 位置（不适合放带边框按钮）用 tapAction（文字链 + 40px 触摸区）；其余响应式按钮组
// 用 pillAction。

export const linkAction = {
  primary: "text-xs text-blue-600 hover:text-blue-800 disabled:opacity-50",
  danger: "text-xs text-red-500 hover:text-red-700 disabled:opacity-50",
  warning: "text-xs text-amber-600 hover:text-amber-800 disabled:opacity-50",
  neutral: "text-xs text-gray-500 hover:text-gray-700 disabled:opacity-50",
} as const;

const tapArea = "inline-flex items-center min-h-[40px] md:min-h-0";

// 文字链 + 移动端 40px 触摸区：用于响应式布局/弹窗内紧跟在文本或 chip 后面的轻量操作
// （如 key chip 里的 Disable/×、移动卡片里代码行旁的 Copy）
export const tapAction = {
  primary: `${linkAction.primary} ${tapArea}`,
  danger: `${linkAction.danger} ${tapArea}`,
  warning: `${linkAction.warning} ${tapArea}`,
  neutral: `${linkAction.neutral} ${tapArea}`,
} as const;

export const pillAction = {
  primary:
    "inline-flex min-h-[40px] items-center justify-center rounded border border-blue-200 px-2.5 text-xs text-blue-600 hover:bg-blue-50 disabled:opacity-50 md:min-h-0 md:py-1",
  danger:
    "inline-flex min-h-[40px] items-center justify-center rounded border border-red-200 px-2.5 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50 md:min-h-0 md:py-1",
  warning:
    "inline-flex min-h-[40px] items-center justify-center rounded border border-amber-300 px-2.5 text-xs text-amber-700 hover:bg-amber-50 disabled:opacity-50 md:min-h-0 md:py-1",
  neutral:
    "inline-flex min-h-[40px] items-center justify-center rounded border border-gray-300 px-2.5 text-xs text-gray-600 hover:bg-gray-50 disabled:opacity-50 md:min-h-0 md:py-1",
} as const;

// 状态徽标（非交互）：启用=绿、停用=灰。开关动作本身用 linkAction / pillAction 的
// neutral 表达（Disable / Enable），不要用可点击的状态徽标兼作开关。
export const statusChip = {
  on: "inline-flex items-center rounded bg-green-50 px-1.5 py-0.5 text-xs text-green-700",
  off: "inline-flex items-center rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500",
} as const;
