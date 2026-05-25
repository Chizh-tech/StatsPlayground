/**
 * Graph Core - 统一图形规范类型
 *
 * 设计目标：
 * - 与具体渲染库（当前为 ECharts）解耦的抽象规范
 * - 描述「图形元素 + 编码通道 + 数据来源」三要素
 * - 可被未来其他模块（统计图、回归图、分布图等）复用
 */

/** 数据字段类型（来自数据表列） */
export type FieldType =
  | "continuous"   // 连续数值
  | "nominal"      // 分类离散
  | "ordinal"      // 有序分类
  | "datetime"     // 时间
  | "id";          // 标识

/** 数据字段引用 */
export interface FieldRef {
  /** 列名，必须存在于数据源中 */
  name: string;
  /** 字段类型，用于决定坐标轴/编码方式 */
  type: FieldType;
}

/** 图形元素类型（一张图可叠加多个元素） */
export type ElementKind =
  | "points"       // 散点
  | "line"         // 折线
  | "bar"          // 柱状（含分组均值）
  | "histogram"    // 直方图
  | "boxplot"      // 箱线
  | "smoother";    // 平滑曲线

/** 平滑器配置 */
export interface SmootherOptions {
  /** 平滑窗口比例 0~1 */
  lambda?: number;
}

/** 点的符号形状 */
export type MarkerShape =
  | "circle"
  | "emptyCircle"
  | "square"
  | "emptySquare"
  | "diamond"
  | "emptyDiamond"
  | "triangle"
  | "emptyTriangle";

/** Style for a single visual mark category (line / fill / point).
 *  Not every field is meaningful for every category — e.g. `marker`
 *  only applies to point marks; `lineWidth` applies to lines and to
 *  the borders of fills/points. Unset fields fall back to defaults. */
export interface MarkStyle {
  /** Stroke color (line stroke / point border / fill border) */
  color?: string;
  /** Fill color (point body / shape body). Defaults to `color`. */
  fillColor?: string;
  /** Marker shape (points only) */
  marker?: MarkerShape;
  /** Marker size px (points only) */
  markerSize?: number;
  /** Line / border width px */
  lineWidth?: number;
  /** Opacity 0..1 */
  opacity?: number;
}

/** Per-group style: every chart element belonging to the group inherits
 *  these line / fill / point sub-styles, regardless of its kind. */
export interface GroupStyle {
  line?: MarkStyle;
  fill?: MarkStyle;
  point?: MarkStyle;
}

/** Map of group key (the category value from the Color/Overlay encoding,
 *  or the empty string for the un-grouped default) → GroupStyle. */
export type GroupStyleMap = Record<string, GroupStyle>;

/** Sentinel key used in `GroupStyleMap` when the chart has no
 *  Color/Overlay split (single-series rendering). */
export const DEFAULT_GROUP_KEY = "__default__";

/** Line style for user-added Y-axis reference lines.
 *  Matches ECharts' three core dash patterns; chosen as a closed enum
 *  (instead of an arbitrary string) so the dropdown UI and the renderer
 *  stay in sync. */
export type RefLineStyle = "solid" | "dashed" | "dotted";

/** User-defined horizontal reference line on the primary Y axis.
 *  Rendered via ECharts `markLine` on an invisible carrier series so it
 *  always appears regardless of which data series the user has enabled. */
export interface RefLineY {
  /** Stable id for React keys and updates. */
  id: string;
  /** Y-axis value the line is drawn at. */
  y: number;
  /** Free-form label text rendered at the right end of the line.
   *  Empty string suppresses the label entirely. */
  label: string;
  /** Visual dash pattern. */
  style: RefLineStyle;
  /** Stroke color (any CSS color string; the UI emits hex). */
  color: string;
  /** Stroke width in CSS px. */
  width: number;
}

/** User overrides for the primary Y axis. Every field is optional and
 *  `undefined` means *auto* — i.e. let ECharts derive the value from the
 *  data range. The whole object being `undefined` (or empty) restores
 *  fully automatic behavior, which is what the "Reset to auto" button in
 *  the Y Axis Settings dialog produces. */
export interface YAxisConfig {
  /** Hard lower bound. `undefined` → auto (data-driven). */
  min?: number;
  /** Hard upper bound. `undefined` → auto (data-driven). */
  max?: number;
  /** Approximate number of tick intervals (ECharts `splitNumber`).
   *  `undefined` → ECharts picks based on chart height. */
  tickCount?: number;
  /** Number of decimal places to show on tick labels.
   *  `undefined` → use ECharts' default numeric formatting. */
  decimals?: number;
  /** Reverse the axis direction (largest at the bottom). */
  inverse?: boolean;
  /** Number of minor sub-ticks drawn between every pair of major
   *  ticks. `undefined` (or 0) → no minor ticks (the default). */
  minorTickCount?: number;
  /** Whether to show the axis boundary line itself. `undefined` → use
   *  theme default (currently visible). Set explicitly to `false` to
   *  hide the axis line, or `true` to lock it on. */
  showAxisLine?: boolean;
  /** Where tick marks point relative to the axis line: `"outside"`
   *  (toward the labels — the default) or `"inside"` (into the plot
   *  area). Only meaningful when the axis line is visible. */
  tickPosition?: "inside" | "outside";
  /** Show major split-lines (gridlines at major ticks). `undefined` →
   *  use theme default (currently visible, dashed). */
  showMajorGrid?: boolean;
  /** Show minor split-lines (gridlines at minor ticks). `undefined` →
   *  use theme default (currently hidden). */
  showMinorGrid?: boolean;
  /** Styling for the major gridlines (color / width / dash). Any
   *  unset sub-field falls back to the theme default. */
  majorGridStyle?: GridLineStyle;
  /** Styling for the minor gridlines (color / width / dash). Any
   *  unset sub-field falls back to the theme default. */
  minorGridStyle?: GridLineStyle;
}

/** Visual style for a major or minor gridline. Mirrors the small subset
 *  of ECharts `lineStyle` options the user actually picks from. Reuses
 *  `RefLineStyle` for the dash pattern so the UI dropdown stays in sync
 *  across editors. Any field left `undefined` keeps the theme default. */
export interface GridLineStyle {
  /** Stroke color (CSS color string, typically a hex from the picker). */
  color?: string;
  /** Stroke width in CSS px. */
  width?: number;
  /** Dash pattern. */
  style?: RefLineStyle;
}

/** 单个图形元素的配置 */
export interface ChartElement {
  kind: ElementKind;
  /** 元素是否启用 */
  enabled?: boolean;
  /** 元素特有选项 */
  options?: SmootherOptions & Record<string, unknown>;
}

/** 编码通道：将数据字段映射到视觉属性 */
export interface Encoding {
  /** X 轴 */
  x?: FieldRef;
  /** Y 轴 */
  y?: FieldRef;
  /** 颜色编码（分组着色 / 连续色阶） */
  color?: FieldRef;
  /** 尺寸编码 */
  size?: FieldRef;
  /** 叠加（同图叠绘多条系列） */
  overlay?: FieldRef;
  /** 横向分面 */
  groupX?: FieldRef;
  /** 纵向分面 */
  groupY?: FieldRef;
  /** 自动换行分面 */
  wrap?: FieldRef;
}

/** 完整的图形规范 */
export interface GraphSpec {
  /** 数据集标识（仅用于缓存/标题） */
  datasetId?: string;
  /** 数据集名称（标题用） */
  datasetName?: string;
  /** 编码 */
  encoding: Encoding;
  /** 图形元素列表（按层叠绘） */
  elements: ChartElement[];
  /** 标题（可选，未提供则按编码生成） */
  title?: string;
  /** Per-group line/fill/point style overrides. Keys are the category
   *  values from `encoding.color`/`encoding.overlay`, or `DEFAULT_GROUP_KEY`
   *  when there is no grouping. Missing entries fall back to JMP-style
   *  defaults (black lines, small black filled dots, gray outliers). */
  styles?: GroupStyleMap;
  /** Group values to hide from the chart (legend show/hide toggle).
   *  Hidden groups keep their color slot reserved so toggling back on
   *  restores the same color, but their series are skipped at render
   *  time and their rows are excluded from shared-axis range computation
   *  so visible data fills the chart area. */
  hiddenGroups?: string[];
  /** User-added horizontal reference lines on the Y axis (e.g. spec
   *  limits, target values, thresholds). Rendered as ECharts markLines
   *  on an invisible carrier series so they appear independently of
   *  which data series are toggled on. */
  refLinesY?: RefLineY[];
  /** Y axis overrides — fixed range, tick density, decimal precision,
   *  reversed direction. `undefined` / empty object means fully
   *  automatic behavior. Edited from the Y Axis Settings dialog
   *  (double-click the Y axis to open). */
  yAxis?: YAxisConfig;
}

/** 原始数据：列式 */
export interface GraphData {
  columns: string[];
  /** 行数据，与 columns 一一对应 */
  rows: unknown[][];
}

/** 字段类型推断：根据列的 SQL 类型字符串 */
export function inferFieldType(sqlType: string): FieldType {
  const t = (sqlType || "").toUpperCase();
  if (
    t.includes("INT") ||
    t.includes("DOUBLE") ||
    t.includes("FLOAT") ||
    t.includes("REAL") ||
    t.includes("DECIMAL") ||
    t.includes("NUMERIC") ||
    t.includes("HUGEINT") ||
    t.includes("BIGINT")
  ) {
    return "continuous";
  }
  if (t.includes("DATE") || t.includes("TIME") || t.includes("TIMESTAMP")) {
    return "datetime";
  }
  if (t.includes("BOOL")) {
    return "nominal";
  }
  return "nominal";
}
