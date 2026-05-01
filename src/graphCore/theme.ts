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
  /** 网格线 */
  gridLine: string;
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

/** 默认 12 色分类调色板（参考 Tableau 10 风格但经过自有调整） */
const DEFAULT_CATEGORICAL = [
  "#4a6cf7",
  "#ef8a3a",
  "#2ca678",
  "#e74c3c",
  "#9168d6",
  "#8c6e3a",
  "#d56cb1",
  "#7f8c8d",
  "#c4ad36",
  "#3aa6b9",
  "#5d8aa8",
  "#b87333",
];

export function getGraphTheme(): GraphTheme {
  return {
    fgPrimary: readCssVar("--fg-primary", "#1a1a2e"),
    fgSecondary: readCssVar("--fg-secondary", "#333"),
    fgDim: readCssVar("--fg-dim", "#999"),
    accent: readCssVar("--fg-accent", "#4a6cf7"),
    gridLine: readCssVar("--border-cell", "#e2e2e2"),
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
    axisLine: { lineStyle: { color: theme.axisLine } },
    axisTick: { lineStyle: { color: theme.axisLine } },
    axisLabel: { color: theme.fgSecondary, fontSize: 11 },
    splitLine: { lineStyle: { color: theme.gridLine, type: "dashed" as const } },
  };
}
