/**
 * Graph Core 主题
 *
 * 从 CSS 变量读取主题 token，生成 ECharts 兼容的样式。
 * 后续可以在此处统一调整所有图形的视觉风格。
 */

export interface GraphTheme {
  /** 文本主色 */
  fgPrimary: string;
  /** 次要文本 */
  fgSecondary: string;
  /** 灰文本 */
  fgDim: string;
  /** 强调色 */
  accent: string;
  /** 网格线（较浅，用于子刻度网格） */
  gridLine: string;
  /** 主刻度网格线（较深，使主/子网格一眼可辨） */
  gridLineMajor: string;
  /** 坐标轴线 */
  axisLine: string;
  /** 画布背景 */
  bgCanvas: string;
  /** 分类调色板 */
  categorical: string[];
  /** 连续色阶（低 → 高） */
  sequential: [string, string];
}

function readCssVar(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

/** 默认 12 色分类调色板（参考 Tableau 10 风格但经过自有调整）
 *  按对比度由高到低排列：前 8 个是高对比度的彩色
 *  （蓝/橙/绿/红/紫/黄/粉/青），后 4 个是低饱和度的灰棕色，
 *  这样图例自动着色时优先把差异最大的颜色分配给前几组。
 *  必须与 GraphBuilderView 里的 GROUP_COLORS 保持完全一致。 */
const DEFAULT_CATEGORICAL = [
  "#4a6cf7", // 蓝
  "#ef8a3a", // 橙
  "#2ca678", // 绿
  "#e74c3c", // 红
  "#9168d6", // 紫
  "#c4ad36", // 黄
  "#d56cb1", // 粉
  "#3aa6b9", // 青
  "#5d8aa8", // 灰蓝
  "#8c6e3a", // 棕
  "#b87333", // 铜
  "#7f8c8d", // 灰
];

export function getGraphTheme(): GraphTheme {
  return {
    fgPrimary: readCssVar("--fg-primary", "#1a1a2e"),
    fgSecondary: readCssVar("--fg-secondary", "#333"),
    fgDim: readCssVar("--fg-dim", "#999"),
    accent: readCssVar("--fg-accent", "#4a6cf7"),
    gridLine: readCssVar("--border-cell", "#e2e2e2"),
    // Slightly darker than `gridLine` so major / minor split-lines are
    // visually distinguishable when both are shown. Read from its own
    // CSS var with a sensible fallback so themes can override it.
    gridLineMajor: readCssVar("--border-grid-major", "#bdbdbd"),
    axisLine: readCssVar("--border-header", "#c0c0c0"),
    bgCanvas: readCssVar("--bg-card", "#ffffff"),
    categorical: DEFAULT_CATEGORICAL,
    sequential: ["#e8edff", "#4a6cf7"],
  };
}

/** 生成 ECharts textStyle / axis 默认样式 */
export function buildAxisCommon(theme: GraphTheme) {
  return {
    nameTextStyle: { color: theme.fgSecondary, fontSize: 12 },
    // Force axisLine / axisTick on. ECharts' value-type yAxis defaults
    // to `axisLine.show = false` and `axisTick.show = false`, so the
    // user-facing "Show axis line" / "Tick position" controls in the
    // Y Axis Settings dialog would otherwise be no-ops out of the box.
    axisLine: { show: true, lineStyle: { color: theme.axisLine } },
    axisTick: { show: true, lineStyle: { color: theme.axisLine } },
    // Hide the bookend boundary labels on value-type axes — ECharts
    // otherwise stamps the EXACT min and max above/below the nice
    // round tick labels (e.g. `4.9100341933248375` on top of the
    // `4.8958 / 4.8458 / …` strip), which looks like noise. The
    // category xAxis path overrides these back to `true` so its
    // first/last category labels still render.
    axisLabel: { color: theme.fgSecondary, fontSize: 11, showMinLabel: false, showMaxLabel: false },
    // Major gridlines pick the darker `gridLineMajor` so they stand
    // apart from the lighter `gridLine` used by minor gridlines below;
    // without that contrast a chart with both shown would look like a
    // single uniform grid.
    splitLine: { lineStyle: { color: theme.gridLineMajor, type: "dashed" as const } },
    // Mirror splitLine's dashed default for minor gridlines so the
    // Tick Grid editor's "Minor gridlines (Dashed)" preset actually
    // renders dashed. ECharts' minorSplitLine.lineStyle defaults to
    // `type: "solid"` and does NOT inherit from splitLine, so without
    // this override the user would see solid lines under a "Dashed"
    // dropdown — a confusing mismatch we patched here in the theme so
    // both the major and minor defaults match.
    minorSplitLine: { lineStyle: { color: theme.gridLine, type: "dashed" as const } },
  };
}
