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

// ---- Aggregate / interval helpers (used by per-element options) -----------

function getOpt<T>(opts: Record<string, unknown> | undefined, key: string, def: T): T {
  const v = opts?.[key];
  return v === undefined ? def : (v as T);
}

function _mean(xs: number[]): number {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : NaN;
}
function _median(xs: number[]): number {
  if (!xs.length) return NaN;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function _sum(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0);
}
function _stddev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = _mean(xs);
  const v = xs.reduce((a, b) => a + (b - m) * (b - m), 0) / (xs.length - 1);
  return Math.sqrt(v);
}
function _stderr(xs: number[]): number {
  return xs.length < 2 ? 0 : _stddev(xs) / Math.sqrt(xs.length);
}
function aggregateY(ys: number[], stat: string): number {
  switch (stat) {
    case "median": return _median(ys);
    case "sum": return _sum(ys);
    case "mean": return _mean(ys);
    default: return _mean(ys);
  }
}
function intervalHalf(ys: number[], kind: string): number {
  if (!ys.length || ys.length < 2) return 0;
  switch (kind) {
    case "stdDev": return _stddev(ys);
    case "ci95": return 1.96 * _stderr(ys);
    case "stdErr":
    case "auto":
      return _stderr(ys);
    default: return 0;
  }
}

/** Build (x, y[, lo, hi]) per X group. Used by points/line summary modes. */
function aggregatePoints(
  rowIdxs: number[],
  data: GraphData,
  xIdx: number,
  yIdx: number,
  xIsCategory: boolean,
  summaryStat: string,
  errorInterval: string,
): Array<{ x: unknown; y: number; lo: number; hi: number }> {
  const map = new Map<string, { xv: unknown; ys: number[] }>();
  for (const i of rowIdxs) {
    const xv = data.rows[i][xIdx];
    const yv = toNum(data.rows[i][yIdx]);
    if (!Number.isFinite(yv)) continue;
    const key = xIsCategory ? toStr(xv) : String(toNum(xv));
    const cur = map.get(key);
    if (cur) cur.ys.push(yv);
    else map.set(key, { xv, ys: [yv] });
  }
  const out = Array.from(map.values()).map(({ xv, ys }) => {
    const y = aggregateY(ys, summaryStat);
    const half = errorInterval === "none" ? 0 : intervalHalf(ys, errorInterval);
    return { x: xv, y, lo: y - half, hi: y + half };
  });
  if (!xIsCategory) {
    out.sort((a, b) => toNum(a.x) - toNum(b.x));
  }
  return out;
}

/** Render error bars / band as additional ECharts series. */
function buildIntervalSeries(
  agg: Array<{ x: unknown; y: number; lo: number; hi: number }>,
  xIsCategory: boolean,
  intervalStyle: string,
  color: string,
  seriesName: string,
): any[] {
  const hasInterval = agg.some((p) => p.hi !== p.lo);
  if (!hasInterval) return [];
  const xv = (p: { x: unknown }) => (xIsCategory ? toStr(p.x) : toNum(p.x));
  if (intervalStyle === "band") {
    // Low line + transparent stack to high; areaStyle fills between.
    return [
      {
        type: "line",
        name: `${seriesName} _lo`,
        stack: `band-${seriesName}`,
        data: agg.map((p) => [xv(p), p.lo]),
        lineStyle: { opacity: 0 },
        symbol: "none",
        silent: true,
        z: 1,
        legendHoverLink: false,
      },
      {
        type: "line",
        name: `${seriesName} _hi`,
        stack: `band-${seriesName}`,
        data: agg.map((p) => [xv(p), p.hi - p.lo]),
        lineStyle: { opacity: 0 },
        symbol: "none",
        areaStyle: { color, opacity: 0.18 },
        silent: true,
        z: 1,
        legendHoverLink: false,
      },
    ];
  }
  // Default: error bars via custom series
  return [
    {
      type: "custom",
      name: `${seriesName} CI`,
      renderItem(_params: any, api: any) {
        const x = api.coord([api.value(0), api.value(1)])[0];
        const yLo = api.coord([api.value(0), api.value(2)])[1];
        const yHi = api.coord([api.value(0), api.value(3)])[1];
        const cap = 4;
        return {
          type: "group",
          children: [
            {
              type: "line",
              shape: { x1: x, y1: yLo, x2: x, y2: yHi },
              style: { stroke: color, lineWidth: 1.5 },
            },
            {
              type: "line",
              shape: { x1: x - cap, y1: yLo, x2: x + cap, y2: yLo },
              style: { stroke: color, lineWidth: 1.5 },
            },
            {
              type: "line",
              shape: { x1: x - cap, y1: yHi, x2: x + cap, y2: yHi },
              style: { stroke: color, lineWidth: 1.5 },
            },
          ],
        };
      },
      encode: { x: 0, y: [2, 3] },
      data: agg.map((p) => [xv(p), p.y, p.lo, p.hi]),
      z: 3,
      silent: true,
      legendHoverLink: false,
    },
  ];
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
      const boxEl = enabledElements.find((e) => e.kind === "boxplot")!;
      const opts = boxEl.options;
      const showOutliers = getOpt<boolean>(opts, "outliers", true);
      const boxType = getOpt<string>(opts, "boxType", "outlier"); // outlier | quantile
      const showFiveNum = getOpt<boolean>(opts, "fiveNumberSummary", false);
      const widthProp = Math.max(0, Math.min(1, getOpt<number>(opts, "widthProportion", 0)));

      // 按 X 分类（若无则全部）
      const xGroups = groupBy(data, xField);
      const cats = Array.from(xGroups.keys());
      const boxData: Array<[number, number, number, number, number]> = [];
      const outlierPts: Array<[string, number]> = [];
      const labels: Array<{ x: string; y: number; text: string }> = [];

      cats.forEach((cat) => {
        const idxs = xGroups.get(cat)!;
        const ys = idxs.map((i) => toNum(data.rows[i][yIdx])).filter(Number.isFinite);
        if (ys.length === 0) {
          boxData.push([0, 0, 0, 0, 0]);
          return;
        }
        const stats = boxStats(ys)!;
        const [absMin, q1, med, q3, absMax] = stats;
        const iqr = q3 - q1;
        let lower = absMin;
        let upper = absMax;
        if (boxType === "outlier") {
          const lo = q1 - 1.5 * iqr;
          const hi = q3 + 1.5 * iqr;
          const inRange = ys.filter((v) => v >= lo && v <= hi);
          if (inRange.length > 0) {
            lower = Math.min(...inRange);
            upper = Math.max(...inRange);
          }
          if (showOutliers) {
            for (const v of ys) {
              if (v < lo || v > hi) outlierPts.push([cat, v]);
            }
          }
        }
        boxData.push([lower, q1, med, q3, upper]);
        if (showFiveNum) {
          labels.push({ x: cat, y: med, text: `${med.toFixed(2)}` });
          labels.push({ x: cat, y: q1, text: `Q1 ${q1.toFixed(2)}` });
          labels.push({ x: cat, y: q3, text: `Q3 ${q3.toFixed(2)}` });
        }
      });

      // widthProportion: map 0..1 → boxWidth max in px; min stays 4
      const maxBoxPx = 12 + widthProp * 60;
      series.push({
        type: "boxplot",
        name: yField?.name,
        data: boxData,
        boxWidth: [4, maxBoxPx],
        itemStyle: { color: theme.categorical[0], borderColor: theme.fgSecondary },
      });
      if (outlierPts.length > 0) {
        series.push({
          type: "scatter",
          name: "Outliers",
          data: outlierPts,
          symbolSize: 5,
          itemStyle: { color: theme.fgSecondary, opacity: 0.85 },
          z: 3,
        });
      }
      if (labels.length > 0) {
        series.push({
          type: "scatter",
          name: "5-Number",
          data: labels.map((l) => [l.x, l.y]),
          symbolSize: 0.1,
          label: {
            show: true,
            position: "right",
            color: theme.fgSecondary,
            fontSize: 10,
            formatter: (params: any) => labels[params.dataIndex]?.text ?? "",
          },
          silent: true,
          z: 4,
        });
      }
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
      const opts = el.options;
      const summaryStat = getOpt<string>(opts, "summaryStat", "none");
      const errorInterval = getOpt<string>(opts, "errorInterval", "auto");
      const intervalStyle = getOpt<string>(opts, "intervalStyle", "errorBar");

      // Aggregated mode: collapse repeated X values to a single summary point
      // (mean/median/sum) plus optional error interval.
      if (summaryStat !== "none" && xIdx >= 0) {
        const agg = aggregatePoints(
          rowIdxs, data, xIdx, yIdx, xIsCategory, summaryStat, errorInterval,
        );
        const out: any[] = [
          {
            type: "scatter",
            name: seriesName,
            symbolSize: 9,
            itemStyle: { color, opacity: 0.95 },
            data: agg.map((p) =>
              xIsCategory ? [toStr(p.x), p.y] : [toNum(p.x), p.y],
            ),
            z: 4,
          },
        ];
        out.push(...buildIntervalSeries(agg, xIsCategory, intervalStyle, color, seriesName));
        return out;
      }

      // Raw scatter (no aggregation). Optional size encoding.
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
      const opts = el.options;
      const rowOrder = getOpt<boolean>(opts, "rowOrder", false);
      const connection = getOpt<string>(opts, "connection", "line"); // line | step | spline
      const summaryStat = getOpt<string>(opts, "summaryStat", "mean");
      const fill = getOpt<string>(opts, "fill", "none"); // none | toZero | between
      const errorInterval = getOpt<string>(opts, "errorInterval", "auto");
      const intervalStyle = getOpt<string>(opts, "intervalStyle", "errorBar");
      const missingValues = getOpt<string>(opts, "missingValues", "connect");

      const isStep = connection === "step" ? "middle" : false;
      const isSpline = connection === "spline";
      const connectNulls = missingValues === "connect";

      // If a non-"none" summary stat is selected, aggregate points per X
      // (this matches JMP-style "Mean line"). Otherwise just plot raw.
      const useAgg = summaryStat !== "none" && xIdx >= 0;
      let lineData: Array<[unknown, number]>;
      let intervalSeries: any[] = [];
      if (useAgg) {
        const agg = aggregatePoints(
          rowIdxs, data, xIdx, yIdx, xIsCategory, summaryStat, errorInterval,
        );
        lineData = agg.map((p) => [
          xIsCategory ? toStr(p.x) : toNum(p.x),
          p.y,
        ]);
        intervalSeries = buildIntervalSeries(agg, xIsCategory, intervalStyle, color, seriesName);
      } else {
        const arr = rowOrder
          ? points
          : [...points].sort((a, b) => {
              const ax = xIsCategory ? toStr(a.x) : toNum(a.x);
              const bx = xIsCategory ? toStr(b.x) : toNum(b.x);
              return ax < bx ? -1 : ax > bx ? 1 : 0;
            });
        lineData = arr.map((p) => [
          xIsCategory ? toStr(p.x) : toNum(p.x),
          p.y,
        ]);
      }

      const lineSeries: any = {
        type: "line",
        name: seriesName,
        showSymbol: false,
        smooth: isSpline,
        step: isStep,
        connectNulls,
        lineStyle: { color, width: 2 },
        itemStyle: { color },
        data: lineData,
        z: 2,
      };
      if (fill === "toZero") {
        lineSeries.areaStyle = { color, opacity: 0.18 };
      }
      // "between" fill is meaningful only with an interval band; if user
      // selected "between" but interval is none, fall back to no fill.
      if (fill === "between" && intervalSeries.length === 0) {
        // no-op
      }
      return [lineSeries, ...intervalSeries];
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
