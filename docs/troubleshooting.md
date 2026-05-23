# 排错笔记

记录在 StatsPlayground 开发过程中遇到并解决的几个有代表性的问题。每条都包含 **现象 → 根因 → 修复 → 余下风险点**，方便以后排查类似情况。

---

## 目录

- [1. `Math.min/max(...arr)` 在大数组上抛 RangeError 并白屏](#1-mathminmaxarr-在大数组上抛-rangeerror-并白屏)
- [2. DualListPicker Shift 多选会单选 / 越界 / 白屏](#2-duallistpicker-shift-多选会单选--越界--白屏)
- [3. React Hooks 顺序 —— `if (!data) return` 之后不能再放 hook](#3-react-hooks-顺序--if-data-return-之后不能再放-hook)
- [附录：通用排查思路](#附录通用排查思路)

---

## 1. `Math.min/max(...arr)` 在大数组上抛 RangeError 并白屏

### 现象

- 在 `DataTableView` 里：
  - 列表头 Shift 多选几百列 × 几百行，或者
  - 左侧"列列表"侧栏 Shift 多选大量列
- 窗口瞬间变 **全白**。
- DevTools 控制台首条红字：
  ```
  Uncaught RangeError: Maximum call stack size exceeded
      at DataTableView.tsx:1015
  ```
- 紧随其后的 React 提示 `An error occurred in the <DataTableView>` 只是**通用兜底**，不是真正异常。

### 根因

`Math.min(...arr)` / `Math.max(...arr)` 会把数组里**每个元素**作为一个函数实参传入。当 `arr.length` 进入 10⁵ 量级时，V8 的**函数实参个数上限**被击穿，抛 `RangeError: Maximum call stack size exceeded`。

工程里没有顶层 `ErrorBoundary`，所以这种渲染期/effect 期未捕获异常会让 React 把整棵子树卸载 —— 表现就是"白屏"。

### 修复模板

用一次性 `for` 循环同时求出 `sum / min / max`，对任意大的数组都安全，而且比 `reduce + 两次 spread` 更快：

```ts
let sum = 0;
let min = Infinity;
let max = -Infinity;
for (let i = 0; i < nums.length; i++) {
  const n = nums[i];
  sum += n;
  if (n < min) min = n;
  if (n > max) max = n;
}
```

### 已修复位置

| 文件 | 行号 (修复前) | 场景 |
|------|--------------|------|
| `src/components/DataTableView.tsx` | ~1015 | 选区状态栏统计 (sum / min / max) |
| `src/components/DataTableView.tsx` | ~3424 | 批量列属性"Auto"按钮的列宽计算 |
| `src/graphCore/transform.ts` | 169-170 | `histogramBins` 求 min/max |
| `src/graphCore/transform.ts` | 579-580 | 箱线图 outlier 分支计算上下须 |
| `src/graphCore/transform.ts` | 896-897 | 散点图 size 编码归一化 |

对应提交：`8246b3a`、`c46f02d`。

### 同类风险

只要往**函数实参里 spread**了一个长度由用户数据决定的数组，都有同样风险。未来代码评审需要警惕：

- `Math.min(...arr)` / `Math.max(...arr)`
- `String.fromCharCode(...arr)`
- `arr.push(...other)`（其中 `other` 长度无上限）
- 任何 `f(...largeArr)` 形式

实际限制因引擎/平台而异 (V8 默认约 ~65535 个参数)，但**任何"可能很大"的数组都不要 spread**。

---

## 2. DualListPicker Shift 多选会单选 / 越界 / 白屏

`DualListPicker` 是 `Subset / Summary / Split / Update` 几个表操作对话框共用的 JMP 风格列选择器。

### 现象

复现路径：

1. 单击一列；
2. 拖滚动条到列表很下方；
3. 按住 Shift 点击另一列想多选 ——
   - 有时只选中**新点击的那一列**（单选）；
   - 有时窗口**白屏**。

### 根因

旧实现把 **数组下标 (index)** 缓存为 Shift 选择的 anchor。但 anchor 之后 `items` 数组可能被父组件刷新（搜索、过滤、外部 state 同步），下标含义改变 —— anchor 要么指向了不同的项（造成奇怪的多选），要么落到了越界位置（在某些路径下抛出错误，再叠加上一节的 `RangeError` 一起白屏）。

### 修复要点

- **以 key 而非 index 作为 anchor**：缓存 `lastLeftClickRef` / `lastRightClickRef` 存的是 `item.key`。
- **`useEffect([items])` 在 items prop 变化时重置 anchor**，避免 stale anchor 越界。
- **Shift 时 anchor 找不到** → 退化为"已选项中离当前点击点最近的一项"作为 anchor，至少给出合理多选区间，不再单选。
- **`handlePaneClick` 整段裹 try/catch**：极端情况捕获并清掉 anchor，绝不让事件回调把整棵 React 子树拖下水。
- **忽略非主键鼠标按钮**：右键/中键不再触发选择逻辑。
- **CSS 加 `user-select: none`** (`.sp-dlp-list`, `.sp-dlp-list-item`)：Shift 多选时不再连带选中文字。

对应提交：`1559406`、`79e3458`。

### 复现验证

修复后，重新在长列表里 Shift 多选大量项：
- 不再单选；
- 不再白屏；
- 文字不会被选中。

---

## 3. React Hooks 顺序 —— `if (!data) return` 之后不能再放 hook

### 现象

`data: null → loaded` 切换的一瞬间窗口白屏，DevTools 报 hooks 数量发生变化 / order changed。

### 根因

`DataTableView.tsx` 中有：

```tsx
if (!data) return <div>{t("dataTable.loading")}</div>;
```

如果在这一行**之后**再调用任何 hook (`useState` / `useEffect` / `useMemo` / `useCallback` / `useRef`)，则：

- `data === null` 时 React 看到 N-1 个 hook；
- `data` 加载完后 React 看到 N 个 hook；
- 两次渲染 hook 数量不一致 → React 抛错 → 整棵子树卸载 → 白屏。

### 规则

> 在 `if (!data) return ...` 这一行**之前**，必须把所有 hook 调用全部声明好。条件返回之后**一行 hook 都不能加**。

历史上这个 bug 已经在 `useRef` / `useEffect` / `useMemo` 上各重犯过一次，**编辑 `DataTableView.tsx` 时务必检查**。

---

## 附录：通用排查思路

### "白屏" 出现时怎么定位

1. **打开 DevTools Console**。
2. **找最上面那条红色 `Uncaught ...`**，而不是 React 的 `"An error occurred in <Xxx>"` 通用提示 —— 后者只指出"最近的组件树位置"，不是真正抛错点。
3. 把红字里的 **`xxx.tsx:行号`** 直接定位到源码。
4. 如果错误是 `Maximum call stack size exceeded` 且发生在数据/统计相关 effect 里，**优先怀疑 `Math.min/max(...)`** 之类的 spread anti-pattern。

### 这个工程目前没有顶层 ErrorBoundary

只要某次渲染或 effect 抛出**未捕获**异常，React 就会卸载整棵子树。这意味着：

- 任何形式的 unbounded operation（参数数量、递归深度、内存）都会被放大成"整窗白屏"。
- 写涉及大数据的代码时要**主动**用 `for` 循环、批处理、`requestIdleCallback` 等防御技巧，而不是依赖框架兜底。

如有需要，后续可在 `Workspace.tsx` 顶层加一个简单的 ErrorBoundary，把异常 fallback 成可读错误页，避免一直裸奔。
