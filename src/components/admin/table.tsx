import type { ReactNode } from "react";

// Admin 面板共享表格组件：以 ModelsPanel 表格形式为基准的双轨骨架
// （桌面 table + 移动端卡片）。仅固化结构与 className，不封装行内容逻辑。
// 约定：新增 Admin 表格必须使用本文件组件。

// 外层卡片 + 标题行（标题/操作区可选，均缺省时不渲染 header 行）
export function AdminTableCard({
  title,
  actions,
  children,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="rounded-lg bg-white p-4 shadow">
      {(title != null || actions != null) && (
        <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          {title}
          {actions}
        </div>
      )}
      {children}
    </div>
  );
}

// 桌面表格外壳：hidden md:block overflow-x-auto > table.w-full.text-sm
export function AdminTable({ children }: { children: ReactNode }) {
  return (
    <div className="hidden md:block overflow-x-auto">
      <table className="w-full text-sm">{children}</table>
    </div>
  );
}

// 表头：tr.text-left.text-xs.text-gray-400，列支持 align: "left" | "right"
export function AdminTableHead({
  columns,
}: {
  columns: Array<{ label: ReactNode; align?: "left" | "right" }>;
}) {
  return (
    <thead>
      <tr className="text-left text-xs text-gray-400">
        {columns.map((c, i) => (
          <th key={i} className={`px-2 py-2${c.align === "right" ? " text-right" : ""}`}>
            {c.label}
          </th>
        ))}
      </tr>
    </thead>
  );
}

// tbody.divide-y.divide-gray-100
export function AdminTableBody({ children }: { children: ReactNode }) {
  return <tbody className="divide-y divide-gray-100">{children}</tbody>;
}

// 单元格：px-2 py-2，支持 align / mono / colSpan / className 追加
export function AdminTd({
  align,
  mono,
  colSpan,
  className,
  title,
  children,
}: {
  align?: "left" | "right";
  mono?: boolean;
  colSpan?: number;
  className?: string;
  title?: string;
  children: ReactNode;
}) {
  return (
    <td
      colSpan={colSpan}
      title={title}
      className={`px-2 py-2${align === "right" ? " text-right" : ""}${mono ? " font-mono text-xs" : ""}${
        className ? ` ${className}` : ""
      }`}
    >
      {children}
    </td>
  );
}

// 空态行：<tr><td colSpan className="px-2 py-4 text-center text-xs text-gray-400">
export function AdminTableEmptyRow({ colSpan, children }: { colSpan: number; children: ReactNode }) {
  return (
    <tr>
      <td colSpan={colSpan} className="px-2 py-4 text-center text-xs text-gray-400">
        {children}
      </td>
    </tr>
  );
}

// 移动端卡片列表外壳：md:hidden space-y-3
export function AdminMobileCards({ children }: { children: ReactNode }) {
  return <div className="md:hidden space-y-3">{children}</div>;
}

// 移动端单卡：border border-gray-200 rounded-lg p-3
export function AdminMobileCard({
  className,
  children,
}: {
  className?: string;
  children: ReactNode;
}) {
  return (
    <div className={`border border-gray-200 rounded-lg p-3${className ? ` ${className}` : ""}`}>
      {children}
    </div>
  );
}

// 移动端空态：<p className="py-4 text-center text-xs text-gray-400">
export function AdminMobileEmpty({ children }: { children: ReactNode }) {
  return <p className="py-4 text-center text-xs text-gray-400">{children}</p>;
}