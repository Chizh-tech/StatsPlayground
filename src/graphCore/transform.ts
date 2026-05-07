/**
 * GraphSpec + GraphData → ECharts option
 *
 * 这是 Graph Core 的核心：一个图形规范如何转译成具体的渲染配置。
 * 当前实现支持 points / line / bar / histogram / boxplot / smoother 6 种元素，
 * 以及 X / Y / Color / Size / Overlay / GroupX / GroupY / Wrap 编码通道。
 */

import type { GraphSpec, GraphData, ChartElement, FieldRef } from "./types";
import { buildAxisCommon, type GraphTheme } from "./theme";
import i18n from "@/i18n";

type EChartsOption = Record<string, unknown>;

/** 取列索引 */
function colIndex(data: GraphData, name: string | undefined): number {
  if (!name) return -1;
  return data.columns.indexOf(name);
}

/** 数值化：null/undefined/空 -> NaN */
function toNum(v: unknown): number {
  if (v == null || v === "") return NaN;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** 字符串化（用于分类轴 / 分组键） */
function toStr(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

/** 按字段对行进行分组 */
function groupBy(
  data: GraphData,
  field: FieldRef | undefined,
): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!field) {
    out.set("__all__", data.rows.map((_, i) => i));
    return out;
  }
  const idx = colIndex(data, field.name);
  if (idx < 0) {
    out.set("__all__", data.rows.map((_, i) => i));
    return out;
  }
  data.rows.forEach((row, i) => {
    const key = toStr(row[idx]);
    let arr = out.get(key);
    if (!arr) {
      arr = [];
      out.set(key, arr);
    }
    arr.push(i);
  });
  return out;
}

/** 简单移动平均平滑器（以 X 排序后窗口平均） */
function movingAverage(points: [number, number][], window: number): [number, number][] {
  if (points.length === 0) return [];
  const sorted = [...points].sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  const half = Math.max(1, Math.floor(window / 2));
  for (let i = 0; i < sorted.length; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(sorted.length - 1, i + half);
    let sum = 0;
    let n = 0;
    for (let j = lo; j <= hi; j++) {
      sum += sorted[j][1];
      n++;
    }
    out.push([sorted[i][0], sum / n]);
  }
  return out;
}

/** 直方图分箱 */
function histogramBins(values: number[], binCount = 20): {
  centers: number[];
  counts: number[];
  width: number;
} {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return { centers: [], counts: [], width: 1 };
  const min = Math.min(...finite);
  const max = Math.max(...finite);
  if (min === max) return { centers: [min], counts: [finite.length], width: 1 };
  const width = (max - min) / binCount;
  const counts = new Array<number>(binCount).fill(0);
  for (const v of finite) {
    let bin = Math.floor((v - min) / width);
    if (bin >= binCount) bin = binCount - 1;
    counts[bin]++;
  }
  const centers = counts.map((_, i) => min + width * (i + 0.5));
  return { centers, counts, width };
}

/** 箱线图统计：min, Q1, median, Q3, max */
function boxStats(values: number[]): [number, number, number, number, number] | null {
  const v = values.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const q = (p: number) => {
    const idx = (v.length - 1) * p;
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return lo === hi ? v[lo] : v[lo] + (v[hi] - v[lo]) * (idx - lo);
  };
  return [v[0], q(0.25), q(0.5), q(0.75), v[v.length - 1]];
}

/** 构建一个简单的「分面」标题（当前在标题中拼接，未实现真正网格分面） */
function facetTitle(facetKey: string, encoding: GraphSpec["encoding"]): string {
  const parts: string[] = [];
  if (encoding.groupX) parts.push(`${encoding.groupX.name}=${facetKey}`);
  return parts.join(" / ");
}

/** 渲染一个单图（不分面）的 ECharts option */
function buildSingleOption(
  spec: GraphSpec,
  data: GraphData,
  theme: GraphTheme,
): EChartsOption {
  const { encoding, elements } = spec;
  const xField = encoding.x;
  const yField = encoding.y;
  const colorField = encoding.color;
  const overlayField = encoding.overlay;
  const sizeField = encoding.size;

  const xIdx = colIndex(data, xField?.name);
  const yIdx = colIndex(data, yField?.name);
  const sizeIdx = colIndex(data, sizeField?.name);

  // 决定 X 轴类型
  const xIsCategory = xField?.type === "nominal" || xField?.type === "ordinal";
  const xIsTime = xField?.type === "datetime";

  const axis = buildAxisCommon(theme);

  const series: any[] = [];
  const legendNames: string[] = [];

  // 按 color/overlay 分组
  const grouping = colorField || overlayField;
  const groups = groupBy(data, grouping);
  const groupKeys = Array.from(groups.keys());

  const enabledElements = elements.filter((e) => e.enabled !== false);

  // —— 直方图：忽略 Y，仅 X 数值 ——
  if (enabledElements.some((e) => e.kind === "histogram")) {
    if (xIdx >= 0) {
      const xs = data.rows.map((r) => toNum(r[xIdx]));
      const { centers, counts, width } = histogramBins(xs, 20);
      series.push({
        type: "bar",
        name: xField?.name || i18n.t("graph.frequency"),
        data: centers.map((c, i) => [c, counts[i]]),
        barWidth: "99%",
        itemStyle: { color: theme.categorical[0] },
      });
      return {
        backgroundColor: "transparent",
        textStyle: { color: theme.fgPrimary },
        grid: { left: 56, right: 24, top: 32, bottom: 48 },
        tooltip: { trigger: "axis" },
        xAxis: {
          type: "value",
          name: xField?.name,
          nameLocation: "middle",
          nameGap: 28,
          ...axis,
        },
        yAxis: {
          type: "value",
          name: i18n.t("graph.frequency"),
          nameLocation: "middle",
          nameGap: 40,
          ...axis,
        },
        series,
        animationDuration: 250,
        _binWidth: width, // 调试用
      } as EChartsOption;
    }
  }

  // —— 箱线图：X 分类，Y 连续 ——
  if (enabledElements.some((e) => e.kind === "boxplot")) {
    if (yIdx >= 0) {
      // 按 X 分类（若无则全部）
      const xGroups = groupBy(data, xField);
      const cats = Array.from(xGroups.keys());
      const boxData = cats.map((cat) => {
        const idxs = xGroups.get(cat)!;
        const ys = idxs.map((i) => toNum(data.rows[i][yIdx]));
        return boxStats(ys) ?? [0, 0, 0, 0, 0];
      });
      series.push({
        type: "boxplot",
        name: yField?.name,
        data: boxData,
        itemStyle: { color: theme.categorical[0], borderColor: theme.fgSecondary },
      });
      return {
        backgroundColor: "transparent",
        textStyle: { color: theme.fgPrimary },
        grid: { left: 56, right: 24, top: 32, bottom: 48 },
        tooltip: { trigger: "item" },
        xAxis: {
          type: "category",
          data: cats,
          name: xField?.name,
          nameLocation: "middle",
          nameGap: 28,
          ...axis,
        },
        yAxis: {
          type: "value",
          name: yField?.name,
          nameLocation: "middle",
          nameGap: 40,
          ...axis,
        },
        series,
      } as EChartsOption;
    }
  }

  // —— 通用 X-Y 元素：points / line / bar / smoother ——
  groupKeys.forEach((gKey, gi) => {
    const color = theme.categorical[gi % theme.categorical.length];
    const rowIdxs = groups.get(gKey)!;
    const seriesName = grouping ? gKey : (yField?.name || "");
    if (grouping && !legendNames.includes(seriesName)) legendNames.push(seriesName);

    enabledElements.forEach((el) => {
      const built = buildElementSeries(el, rowIdxs, data, {
        xIdx,
        yIdx,
        sizeIdx,
        xIsCategory,
        xIsTime,
        seriesName,
        color,
      });
      if (built) series.push(...built);
    });
  });

  const xAxis = xIsCategory
    ? {
        type: "category",
        // 收集所有 X 类目（按出现顺序）
        data: collectCategories(data, xIdx),
        name: xField?.name,
        nameLocation: "middle",
        nameGap: 28,
        ...axis,
      }
    : xIsTime
      ? {
          type: "time",
          name: xField?.name,
          nameLocation: "middle",
          nameGap: 28,
          ...axis,
        }
      : {
          type: "value",
          name: xField?.name,
          nameLocation: "middle",
          nameGap: 28,
          scale: true,
          ...axis,
        };

  return {
    backgroundColor: "transparent",
    textStyle: { color: theme.fgPrimary },
    grid: { left: 60, right: 24, top: legendNames.length > 0 ? 48 : 32, bottom: 48 },
    tooltip: { trigger: "item" },
    legend:
      legendNames.length > 0
        ? {
            data: legendNames,
            top: 4,
            textStyle: { color: theme.fgSecondary, fontSize: 12 },
            icon: "circle",
          }
        : undefined,
    xAxis,
    yAxis: {
      type: "value",
      name: yField?.name,
      nameLocation: "middle",
      nameGap: 44,
      scale: true,
      ...axis,
    },
    series,
    animationDuration: 250,
  } as EChartsOption;
}

function collectCategories(data: GraphData, xIdx: number): string[] {
  if (xIdx < 0) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of data.rows) {
    const k = toStr(r[xIdx]);
    if (!seen.has(k)) {
      seen.add(k);
      out.push(k);
    }
  }
  return out;
}

interface BuildCtx {
  xIdx: number;
  yIdx: number;
  sizeIdx: number;
  xIsCategory: boolean;
  xIsTime: boolean;
  seriesName: string;
  color: string;
}

function buildElementSeries(
  el: ChartElement,
  rowIdxs: number[],
  data: GraphData,
  ctx: BuildCtx,
): any[] | null {
  const { xIdx, yIdx, sizeIdx, xIsCategory, seriesName, color } = ctx;
  if (xIdx < 0 || yIdx < 0) return null;

  // 取 (x, y[, size]) 数组
  const points: Array<{ x: unknown; y: number; size?: number }> = [];
  for (const i of rowIdxs) {
    const xv = data.rows[i][xIdx];
    const yv = toNum(data.rows[i][yIdx]);
    if (!Number.isFinite(yv)) continue;
    const sv = sizeIdx >= 0 ? toNum(data.rows[i][sizeIdx]) : undefined;
    points.push({ x: xv, y: yv, size: sv });
  }
  if (points.length === 0) return null;

  switch (el.kind) {
    case "points": {
      // 自适应符号大小
      let sizes: number[] | null = null;
      if (sizeIdx >= 0) {
        const ss = points.map((p) => p.size ?? NaN).filter(Number.isFinite);
        if (ss.length > 0) {
          const min = Math.min(...ss);
          const max = Math.max(...ss);
          const range = max - min || 1;
          sizes = points.map((p) =>
            Number.isFinite(p.size!) ? 6 + ((p.size! - min) / range) * 22 : 6,
          );
        }
      }
      return [
        {
          type: "scatter",
          name: seriesName,
          symbolSize: sizes ? (_val: any, params: any) => sizes![params.dataIndex] : 7,
          itemStyle: { color, opacity: 0.85 },
          data: points.map((p) =>
            xIsCategory ? [toStr(p.x), p.y] : [toNum(p.x), p.y],
          ),
        },
      ];
    }
    case "line": {
      // 按 X 排序连接
      const sorted = [...points].sort((a, b) => {
        const ax = xIsCategory ? toStr(a.x) : toNum(a.x);
        const bx = xIsCategory ? toStr(b.x) : toNum(b.x);
        return ax < bx ? -1 : ax > bx ? 1 : 0;
      });
      return [
        {
          type: "line",
          name: seriesName,
          showSymbol: false,
          smooth: false,
          lineStyle: { color, width: 2 },
          itemStyle: { color },
          data: sorted.map((p) =>
            xIsCategory ? [toStr(p.x), p.y] : [toNum(p.x), p.y],
          ),
        },
      ];
    }
    case "bar": {
      // 按 X 分组求均值
      const bins = new Map<string, { sum: number; n: number; xv: unknown }>();
      for (const p of points) {
        const key = toStr(p.x);
        const b = bins.get(key);
        if (b) {
          b.sum += p.y;
          b.n++;
        } else {
          bins.set(key, { sum: p.y, n: 1, xv: p.x });
        }
      }
      const arr = Array.from(bins.entries()).map(([k, b]) =>
        xIsCategory ? [k, b.sum / b.n] : [toNum(b.xv), b.sum / b.n],
      );
      return [
        {
          type: "bar",
          name: seriesName,
          itemStyle: { color, opacity: 0.85 },
          data: arr,
        },
      ];
    }
    case "smoother": {
      // 仅在数值 X 上有效
      if (xIsCategory) return null;
      const xy: [number, number][] = points
        .map((p) => [toNum(p.x), p.y] as [number, number])
        .filter((p) => Number.isFinite(p[0]));
      const lambda = (el.options?.lambda as number | undefined) ?? 0.4;
      const win = Math.max(3, Math.floor(xy.length * Math.max(0.05, Math.min(0.9, lambda))));
      const smoothed = movingAverage(xy, win);
      return [
        {
          type: "line",
          name: `${seriesName} 平滑`,
          showSymbol: false,
          smooth: true,
          lineStyle: { color, width: 2.5, type: "solid" },
          itemStyle: { color },
          z: 5,
          data: smoothed,
        },
      ];
    }
    default:
      return null;
  }
}

/**
 * 主入口：将 GraphSpec + GraphData 转换为 ECharts option（或多面板列表）。
 *
 * 当前实现：分面（groupX/groupY/wrap）以多个独立 option 返回，
 * 由 <Graph> 组件渲染为网格。
 */
export interface BuiltGraph {
  /** 子图列表（无分面时长度为 1） */
  panels: { title: string; option: EChartsOption }[];
  /** 网格列数（用于布局） */
  cols: number;
}

export function buildGraph(
  spec: GraphSpec,
  data: GraphData,
  theme: GraphTheme,
): BuiltGraph {
  const { encoding } = spec;
  const facetField = encoding.groupX || encoding.wrap;

  if (!facetField) {
    return {
      panels: [{ title: spec.title || "", option: buildSingleOption(spec, data, theme) }],
      cols: 1,
    };
  }

  const idx = colIndex(data, facetField.name);
  if (idx < 0) {
    return {
      panels: [{ title: spec.title || "", option: buildSingleOption(spec, data, theme) }],
      cols: 1,
    };
  }

  // 收集 facet 类目（按出现顺序）
  const seen: string[] = [];
  const seenSet = new Set<string>();
  for (const r of data.rows) {
    const k = toStr(r[idx]);
    if (!seenSet.has(k)) {
      seenSet.add(k);
      seen.push(k);
    }
  }

  const panels = seen.map((key) => {
    const subRows = data.rows.filter((r) => toStr(r[idx]) === key);
    const subData: GraphData = { columns: data.columns, rows: subRows };
    const subSpec: GraphSpec = {
      ...spec,
      encoding: { ...encoding, groupX: undefined, wrap: undefined },
    };
    return {
      title: facetTitle(key, encoding),
      option: buildSingleOption(subSpec, subData, theme),
    };
  });

  // 列数：wrap 时根据数量自动；groupX 时全部一行
  const cols = encoding.wrap ? Math.min(4, Math.ceil(Math.sqrt(panels.length))) : panels.length;
  return { panels, cols: Math.max(1, cols) };
}
