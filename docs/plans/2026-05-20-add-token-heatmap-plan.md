# Add All Tokens Heatmap to Top 5 Model Families

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 Top 5 Model Families 表格中新增"All Tokens"列，通过水平色条直观展示各 model 的 token 用量差异。

**Architecture:** 修改 Dashboard.tsx，在表格中新增一列显示 All Tokens（= Input + Output）的水平色条。色条长度和颜色深浅均表示该 model 相对最大用量的比例。使用 Tailwind CSS 的蓝色系渐变。

**Tech Stack:** React, TypeScript, Tailwind CSS

---

## 文件结构

```
src/components/Dashboard.tsx  # 修改：在 Top 5 Model Families 表格中添加色条列
```

---

## Task 1: 修改 Dashboard.tsx 添加 All Tokens 色条列

**Files:**
- Modify: `src/components/Dashboard.tsx:290-318`

- [x] **Step 1.1: 在表格表头添加"All Tokens"列**

在表头 `<tr>` 中，在"Model"列之后添加：

```tsx
<th className="px-4 py-3 text-left text-xs font-medium text-gray-500 uppercase">All Tokens</th>
```

- [x] **Step 1.2: 计算每个 model 的 All Tokens 和最大值**

在表格渲染区域上方计算：

```tsx
const maxAllTokens = Math.max(...topModels.map(m => m.totalInput + m.totalOutput));
```

- [x] **Step 1.3: 在每行中添加色条单元格**

在每行 `<tr>` 中，在 Model 单元格之后添加：

```tsx
<td className="px-4 py-3">
  {(() => {
    const allTokens = model.totalInput + model.totalOutput;
    const percentage = maxAllTokens > 0 ? (allTokens / maxAllTokens) * 100 : 0;
    return (
      <div className="flex items-center gap-2">
        <div className="w-24 h-2.5 bg-gray-100 rounded-full overflow-hidden flex-shrink-0">
          <div 
            className="h-full rounded-full bg-blue-500"
            style={{ width: `${percentage}%` }}
          />
        </div>
        <span className="text-sm text-gray-600 whitespace-nowrap">
          {formatNumber(allTokens)}
        </span>
      </div>
    );
  })()}
</td>
```

---

## 验证步骤

- [ ] 启动开发服务器：`npm run dev`
- [ ] 打开 Dashboard 页面，确认 Top 5 Model Families 表格中新增"All Tokens"列
- [ ] 确认色条长度和数值正确反映各 model 的 Input + Output 总量
- [ ] 确认色条在暗色/亮色模式下均可见

---

*Plan complete.*
