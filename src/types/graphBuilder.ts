/**
 * 图表构建器项 — 与数据表平行的项目级实体。
 *
 * 引用一个数据表作为数据源，自身仅保存编码与元素配置。
 */

import type { ChartElement, FieldRef, GroupStyleMap, RefLineY, RefLineX, YAxisConfig } from "@/graphCore";
import type { FilterRuleItem } from "./filter";
import type { GraphSampling } from "./graphData";

export type GraphSlotKey =
  | "x"
  | "y"
  | "z"
  | "color"
  | "size"
  | "overlay"
  | "groupX"
  | "groupY"
  | "groupZ"
  | "wrap";

export interface GraphBuilderItem {
  /** 唯一 ID */
  id: string;
  /** 显示名称 */
  name: string;
  /** 引用的数据表 ID */
  sourceDatasetId: string;
  /** 编码槽：字段引用 */
  encoding: Partial<Record<GraphSlotKey, FieldRef>>;
  /** Multi-column mode on the X axis. When the user drops 2+ numeric
   *  columns onto the X slot at once, the slot enters "multi-mode":
   *  `encoding.x` is cleared and the dropped columns are stored here
   *  in display order. Two render modes are derived from `multiY`:
   *    - other axis empty → "axis mode": the column NAMES become the
   *      X category axis and their VALUES become the Y axis (quick
   *      side-by-side comparison of similar-typed columns).
   *    - other axis bound → "merge mode": all column values are
   *      concatenated into one anonymous X series against the bound Y.
   *  Single-column drops never enter multi-mode — they use the
   *  existing replace logic on `encoding.x`. Drops while already in
   *  multi-mode APPEND to this list; mixing in a non-numeric column
   *  is rejected with a brief visual flash. Length-0 or undefined ==
   *  "not in multi-mode". Length-1 is automatically collapsed back
   *  to `encoding.x` so this never holds exactly one. */
  multiX?: FieldRef[];
  /** Mirror of `multiX` for the Y axis. See `multiX` for the full
   *  semantics — Y and X are completely symmetric. */
  multiY?: FieldRef[];
  /** 启用的图形元素 */
  elements: ChartElement[];
  /** 平滑器 lambda 0~1 */
  smootherLambda: number;
  /** Raw-point sampling mode persisted on the graph item. Missing
   *  values from older project files are treated as full data. */
  sampling?: GraphSampling;
  /** Per-group line/fill/point style overrides. Keys are the category
   *  values from the Color/Overlay encoding (or DEFAULT_GROUP_KEY). */
  groupStyles?: GroupStyleMap;
  /** Legend entries the user has explicitly hidden via the eye-icon
   *  toggle. Hidden groups are excluded from the rendered series and
   *  from the shared-axis range calculation, but keep their slot in
   *  globalGroupKeys so unhiding restores the same color. */
  hiddenGroups?: string[];
  /** JMP-style Local Data Filter rules. Each rule narrows (AND) or
   *  expands (OR) the row set fed into the graph. Stored on the item so
   *  it persists with the project and survives reloads. */
  filters?: FilterRuleItem[];
  /** User-defined horizontal reference lines on the primary Y axis
   *  (spec limits, targets, thresholds). Each carries its own Y value,
   *  label, color, dash style and stroke width. Persisted with the
   *  project so annotations survive reloads. Only drawn when Y is
   *  bound to a value-type column — lines on a categorical Y are
   *  silently skipped (they remain in the spec, so re-binding Y to a
   *  numeric column restores them). */
  refLinesY?: RefLineY[];
  /** User-defined vertical reference lines on the primary X axis.
   *  Mirror of `refLinesY` — only drawn when X is bound to a
   *  value-type column. Together with `refLinesY`, these stay in
   *  lock-step with the Swap X / Y toolbar button: swapping the
   *  encoding also swaps `refLinesX` ↔ `refLinesY` (with the
   *  per-row `{x}` ↔ `{y}` field rename) so the rotated chart shows
   *  the same markers on the same axis as before the swap. */
  refLinesX?: RefLineX[];
  /** When true, the renderer auto-overlays spec-limit reference lines
   *  (USL / LSL red, Target green) on the **Y axis**, sourced from
   *  the Y column's `extras.spec` metadata. Per-axis flag — does NOT
   *  affect X. Defaults to off.
   *
   *  These lines are NOT added to `refLinesY` — they live as an
   *  ambient, data-driven overlay that follows the current Y
   *  encoding. */
  autoSpecLinesY?: boolean;
  /** Mirror of `autoSpecLinesY` for the **X axis**. When true, the
   *  renderer overlays spec-limit lines sourced from the X column's
   *  `extras.spec` metadata. Independent of `autoSpecLinesY`: a chart
   *  with both X and Y bound to value columns carrying spec extras
   *  can show one, the other, or both overlays. Defaults to off. */
  autoSpecLinesX?: boolean;
  /** @deprecated Legacy single global flag (pre-symmetric build). Kept
   *  only so existing .spgh projects keep working: on read, this
   *  value is used as a fallback for whichever per-axis flag is
   *  still `undefined`. Newer writes always set the per-axis fields
   *  (`autoSpecLinesY` / `autoSpecLinesX`) directly and ignore this. */
  autoSpecLines?: boolean;
  /** User overrides for the primary Y axis — fixed min/max range,
   *  tick density (splitNumber), decimal precision on tick labels,
   *  and reversed direction. `undefined` or an empty object means
   *  fully automatic. Edited from the Y Axis Settings dialog
   *  (double-click the Y axis). */
  yAxis?: YAxisConfig;
  /** User overrides for the primary X axis — same shape as `yAxis`.
   *  Edited from the X Axis Settings dialog (double-click the X
   *  axis). Numeric fields only take effect on value-type X axes;
   *  inverse / axis-line / tick-position / gridline settings apply
   *  to category and time axes too. */
  xAxis?: YAxisConfig;
  /** 创建时间 ISO 字符串。
 *
 *  注：图所属的文件夹不属于图本身的内禀属性——按 #7 设计，文件夹只
 *  是图在 spprj 内被放置到的位置。该映射由 `useFolderStore.graphFolders`
 *  统一管理，保存时单独传给后端，绝不持久化在 .spgh 文件体里。 */
  createdAt: string;

  /** 3D 模式开关。开启后中心绘图区切换为三维渲染，并显示 Z /
   *  Group Z 编码槽（Z 在 Y 轴拖动区左侧，Group Z 在 Group Y 右侧）。
   *  关闭时 Z / Group Z 的编码（`encoding.z` / `encoding.groupZ`）仍
   *  保留在项目中，只是槽位隐藏、3D 图形不渲染；再次开启即恢复。
   *  `undefined` 视为关闭。 */
  threeD?: boolean;
}

export function isCorrelationMatrixItem(item: GraphBuilderItem): boolean {
  return item.elements.some(
    (element: ChartElement) =>
      element.enabled !== false && element.kind === "correlationMatrix",
  );
}
