/**
 * GraphSpec + GraphData → ECharts option
 *
 * 这是 Graph Core 的核心：一个图形规范如何转译成具体的渲染配置。
 * 当前实现支持 points / line / bar / histogram / boxplot / smoother 6 种元素，
 * 以及 X / Y / Color / Size / Overlay / GroupX / GroupY / Wrap 编码通道。
 */

import type { GraphSpec, GraphData, ChartElement, FieldRef, GroupStyle, MarkerShape, RefLineY, RefLineStyle, YAxisConfig, GridLineStyle } from "./types";
import { DEFAULT_GROUP_KEY } from "./types";
import { buildAxisCommon, type GraphTheme } from "./theme";
import i18n from "@/i18n";

type EChartsOption = Record<string, unknown>;

/** Resolved per-group style. Whichever element kinds are active in the
 *  group will pull styling from the matching sub-mark (line for line/
 *  smoother/box border/error bar, fill for box body/area band, point
 *  for scatter/summary dot/outliers). */
export interface ResolvedGroupStyle {
  line: { color: string; width: number; opacity: number };
  fill: { color: string; opacity: number };
  point: {
    color: string;          // border / stroke color
    fillColor: string;      // body color (transparent for hollow markers)
    marker: MarkerShape;
    size: number;
    opacity: number;
  };
  /** Outlier dots inherit the point style but default to a smaller, gray
   *  dot when the user hasn't overridden the point color. */
  outlier: { color: string; size: number; opacity: number };
}

/** Per-mark shade ratios — Point darkest, Line mid (base), Fill lightest.
 *  Must stay in sync with the panel's GraphBuilderView constants so the
 *  legend swatch on the right matches what ECharts renders on the canvas. */
const SHADE_RATIO_POINT = -0.2;
const SHADE_RATIO_LINE = 0;
const SHADE_RATIO_FILL = 0.55;

/** Mix `hex` toward black (ratio<0) or white (ratio>0). ratio in [-1,1]. */
function shade(hex: string, ratio: number): string {
  if (!hex || ratio === 0) return hex;
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return hex;
  const hh = m[1];
  const r = parseInt(hh.slice(0, 2), 16);
  const g = parseInt(hh.slice(2, 4), 16);
  const b = parseInt(hh.slice(4, 6), 16);
  const mix = (c: number) =>
    ratio < 0 ? Math.round(c * (1 + ratio)) : Math.round(c + (255 - c) * ratio);
  const clamp = (n: number) => Math.max(0, Math.min(255, n));
  const toHex = (n: number) => clamp(n).toString(16).padStart(2, "0");
  return `#${toHex(mix(r))}${toHex(mix(g))}${toHex(mix(b))}`;
}

/** Bake an alpha channel into a hex color so the fill alpha can be set
 *  independently of any shape-level `opacity` (which otherwise affects
 *  both fill and border together — see boxplot itemStyle). */
function withAlpha(color: string, alpha: number): string {
  if (!color || color === "transparent") return color;
  const a = Math.max(0, Math.min(1, alpha));
  const m = /^#?([0-9a-f]{6})$/i.exec(color);
  if (!m) return color;
  const r = parseInt(m[1].slice(0, 2), 16);
  const g = parseInt(m[1].slice(2, 4), 16);
  const b = parseInt(m[1].slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${a})`;
}

/** Compute the JMP-style defaults plus any per-group overrides.
 *
 *  Each legend group is auto-themed: from one base hue we derive a
 *  darker shade for the Point, the base shade for the Line, and a much
 *  lighter shade for the Fill. The shading keeps the three sub-marks
 *  visually distinguishable when they're layered on top of each other
 *  (otherwise the fill swallows the line and the point disappears). */
function resolveGroupStyle(
  groupKey: string,
  groupColor: string,
  grouping: boolean,
  theme: GraphTheme,
  styles: Record<string, GroupStyle> | undefined,
): ResolvedGroupStyle {
  const stored: GroupStyle = (styles && (styles[groupKey] ?? styles[DEFAULT_GROUP_KEY])) || {};
  // For ungrouped charts the panel's STYLE editor treats "no override" as
  // equivalent to the first preset theme (LINE_PALETTE[0] = '#000000',
  // FILL_PALETTE[0] = shade('#000000', 0.55), POINT_PALETTE[0] = '#000000')
  // — that's how the THEME picker auto-highlights theme[0] when nothing
  // is stored. Use the same literal '#000000' here (instead of
  // theme.fgPrimary, which is '#1a1a2e' in light mode) so the chart
  // actually paints theme[0]'s colors when the user clicks Reset.
  // Otherwise the legend swatch says "theme[0] selected" but the chart
  // renders a slightly different shade, making Reset look broken.
  const baseColor = grouping ? groupColor : "#000000";

  // Line defaults: thin, solid, baseColor (mid shade).
  const lineColor = stored.line?.color ?? (grouping ? shade(baseColor, SHADE_RATIO_LINE) : baseColor);
  const lineWidth = stored.line?.lineWidth ?? 1.5;
  const lineOpacity = stored.line?.opacity ?? 1;

  // Fill defaults: hollow when single-group (preserves the JMP look),
  // lighter shade of the categorical color when grouped so multiple
  // groups stay distinguishable without being noisy. Opacity defaults
  // to fully opaque — the lightened shade already provides enough
  // visual breathing room for the line/point on top to read clearly.
  const fillColor = stored.fill?.color ?? stored.fill?.fillColor
    ?? (grouping ? shade(baseColor, SHADE_RATIO_FILL) : "transparent");
  const fillOpacity = stored.fill?.opacity ?? 1;

  // Point defaults: filled circle 4px. When grouping, use the darker
  // shade so points read clearly on top of the lighter fill.
  const pointMarker: MarkerShape = stored.point?.marker ?? "circle";
  const pointDefault = grouping ? shade(baseColor, SHADE_RATIO_POINT) : baseColor;
  const pointStroke = stored.point?.color ?? pointDefault;
  const pointFill = stored.point?.fillColor ?? pointStroke;
  const pointSize = stored.point?.markerSize ?? 4;
  const pointOpacity = stored.point?.opacity ?? (grouping ? 0.9 : 1);

  // Outlier defaults: gray when point is at default; otherwise inherit.
  const outlierColor = stored.point?.color ?? (theme.fgDim || "#999");
  const outlierSize = Math.max(2, (stored.point?.markerSize ?? 4));
  const outlierOpacity = stored.point?.opacity ?? 0.85;

  return {
    line: { color: lineColor, width: lineWidth, opacity: lineOpacity },
    fill: { color: fillColor, opacity: fillOpacity },
    point: {
      color: pointStroke,
      fillColor: pointFill,
      marker: pointMarker,
      size: pointSize,
      opacity: pointOpacity,
    },
    outlier: { color: outlierColor, size: outlierSize, opacity: outlierOpacity },
  };
}

/** Translate a marker shape into ECharts symbol + whether it's filled. */
function markerToSymbol(m: MarkerShape): { symbol: string; hollow: boolean } {
  switch (m) {
    case "emptyCircle": return { symbol: "emptyCircle", hollow: true };
    case "square": return { symbol: "rect", hollow: false };
    case "emptySquare": return { symbol: "rect", hollow: true };
    case "diamond": return { symbol: "diamond", hollow: false };
    case "emptyDiamond": return { symbol: "diamond", hollow: true };
    case "triangle": return { symbol: "triangle", hollow: false };
    case "emptyTriangle": return { symbol: "triangle", hollow: true };
    case "circle":
    default: return { symbol: "circle", hollow: false };
  }
}

/** Build itemStyle for a point series given the resolved point sub-mark. */
function pointItemStyle(p: ResolvedGroupStyle["point"], hollow: boolean) {
  return hollow
    ? { color: "transparent", borderColor: p.color, borderWidth: 1, opacity: p.opacity }
    : { color: p.fillColor, borderColor: p.color, opacity: p.opacity };
}

/** 取列索引 */
function colIndex(data: GraphData, name: string | undefined): number {
  if (!name) return -1;
  return data.columns.indexOf(name);
}

/** 数值化：null/undefined/空/纯空白 -> NaN
 *
 *  Notably this guards against the silent `Number("")===0` and
 *  `Number(" ")===0` traps in JavaScript: without the explicit
 *  emptiness check below, a blank cell would be plotted at y=0 (or
 *  bucketed into the "0" bin) instead of being dropped as missing.
 *  We also `trim()` short strings to catch CSV imports that leave a
 *  stray space/tab in cells the user perceives as empty. */
function toNum(v: unknown): number {
  if (v == null) return NaN;
  if (typeof v === "string" && v.trim() === "") return NaN;
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : NaN;
}

/** True when `v` should be treated as a missing observation (null,
 *  undefined, empty string, or whitespace-only string). Centralises the
 *  policy used by both numeric and categorical paths so the graph
 *  doesn't render phantom "" categories alongside real ones.
 *
 *  Exported because the legend builder in GraphBuilderView reuses the
 *  same predicate to drop legend entries whose group has no plottable
 *  rows (matches the per-element missing-data policy used here). */
export function isMissing(v: unknown): boolean {
  if (v == null) return true;
  if (typeof v === "string" && v.trim() === "") return true;
  return false;
}

/** 字符串化（用于分类轴 / 分组键） */
function toStr(v: unknown): string {
  if (v == null) return "";
  return String(v);
}

/**
 * Reorder a list of category names by the user-defined value order.
 * - Values present in `order` come first, in the order declared.
 * - Values NOT in `order` keep their natural (data) order, appended at
 *   the end. This matches the JMP behavior described in the i18n
 *   `missingHint` string and avoids surprising data loss when the user
 *   adds a new category to the column without updating Value Order.
 * - Returns the original `values` reference when `order` is empty (no
 *   re-shuffling needed), so downstream code that holds onto the array
 *   stays referentially stable.
 */
function applyValueOrder(values: string[], order: string[] | undefined): string[] {
  if (!order || order.length === 0) return values;
  const valueSet = new Set(values);
  const head: string[] = [];
  const headSet = new Set<string>();
  for (const v of order) {
    if (valueSet.has(v) && !headSet.has(v)) {
      head.push(v);
      headSet.add(v);
    }
  }
  const tail = values.filter((v) => !headSet.has(v));
  if (head.length === 0) return values;
  return [...head, ...tail];
}

/** Reorder a Map's keys by `applyValueOrder`. Preserves the value arrays. */
function reorderMapByValueOrder<V>(m: Map<string, V>, order: string[] | undefined): Map<string, V> {
  if (!order || order.length === 0) return m;
  const keys = Array.from(m.keys());
  const reordered = applyValueOrder(keys, order);
  if (reordered === keys) return m;
  const out = new Map<string, V>();
  for (const k of reordered) out.set(k, m.get(k)!);
  return out;
}

/** 按字段对行进行分组
 *
 *  Rows whose grouping value is missing (null / undefined / blank
 *  string) are excluded entirely instead of collapsing into a phantom
 *  empty-string bucket. This keeps blanks out of the X axis, the
 *  legend, and downstream aggregations such as the boxplot's per-X
 *  cells, where they would otherwise have rendered as a category
 *  labelled "" sitting next to a flat box at zero. */
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
    const raw = row[idx];
    if (isMissing(raw)) return;
    const key = toStr(raw);
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
  // Use a single-pass loop instead of Math.min/max(...finite) so large
  // datasets don't overflow V8's argument-count limit (RangeError).
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i < finite.length; i++) {
    const v = finite[i];
    if (v < min) min = v;
    if (v > max) max = v;
  }
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

/** Compute per-point horizontal jitter offsets in CSS pixels.
 *
 *  - `auto` produces JMP-style "stack jitter": within each X category, Y
 *    values are binned at roughly one symbol height; the points sharing a
 *    bin are spread side by side around the X position, so every point is
 *    visible without overlap.
 *  - `uniform` / `normal` apply random pixel-space noise.
 *  - `none` returns null (caller should skip applying offsets).
 *
 *  Returns one [dx, 0] tuple per input point or null if no jitter requested.
 */
function computeJitterOffsets(
  points: Array<{ x: unknown; y: number }>,
  mode: string,
  limit: number,
): Array<[number, number]> | null {
  if (mode === "none" || points.length === 0) return null;
  // Pixel spacing between adjacent stacked symbols. ECharts default scatter
  // is ~6px, give a little air around it so dots don't kiss.
  const SYMBOL_PX = 6;
  const SPACING = SYMBOL_PX + 1;
  // Maximum total horizontal spread per category (capped at the typical
  // category band ~ 60px). `limit` (0..1) scales it.
  const MAX_SPREAD = 60 * (limit > 0 ? limit : 1);

  if (mode === "uniform" || mode === "normal") {
    const half = MAX_SPREAD / 2;
    const offs: Array<[number, number]> = new Array(points.length);
    for (let i = 0; i < points.length; i++) {
      let r: number;
      if (mode === "normal") {
        // Box-Muller, clamp to [-1, 1].
        const u = Math.random() || 1e-9;
        const v = Math.random();
        r = Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) / 3;
        r = Math.max(-1, Math.min(1, r));
      } else {
        r = Math.random() * 2 - 1;
      }
      offs[i] = [r * half, 0];
    }
    return offs;
  }

  // "auto" → deterministic stack jitter.
  // 1) Group by category.
  const groups = new Map<string, number[]>();
  for (let i = 0; i < points.length; i++) {
    const k = toStr(points[i].x);
    let arr = groups.get(k);
    if (!arr) { arr = []; groups.set(k, arr); }
    arr.push(i);
  }
  // 2) Compute a Y bin width: target ~80 bins across the visible Y span.
  let yMin = Infinity, yMax = -Infinity;
  for (const p of points) {
    if (p.y < yMin) yMin = p.y;
    if (p.y > yMax) yMax = p.y;
  }
  const yRange = yMax - yMin || 1;
  const binSize = yRange / 80;

  const offs: Array<[number, number]> = new Array(points.length);
  for (let i = 0; i < points.length; i++) offs[i] = [0, 0];

  groups.forEach((idxs) => {
    // Bin indices within this category.
    const bins = new Map<number, number[]>();
    for (const idx of idxs) {
      const b = Math.round((points[idx].y - yMin) / binSize);
      let arr = bins.get(b);
      if (!arr) { arr = []; bins.set(b, arr); }
      arr.push(idx);
    }
    bins.forEach((bucket) => {
      const n = bucket.length;
      // Center the bucket horizontally; cap total width at MAX_SPREAD.
      const spacing = Math.min(SPACING, n > 1 ? MAX_SPREAD / (n - 1) : SPACING);
      const center = (n - 1) / 2;
      bucket.forEach((idx, k) => {
        offs[idx] = [(k - center) * spacing, 0];
      });
    });
  });
  return offs;
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
    // Drop missing X up-front so blank cells don't all collapse into a
    // phantom "NaN" / "" bucket that plots near zero on a value axis.
    if (isMissing(xv)) continue;
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
        id: `${seriesName}__band_lo`,
        type: "line",
        name: `${seriesName} _lo`,
        stack: `band-${seriesName}`,
        data: agg.map((p) => [xv(p), p.lo]),
        lineStyle: { opacity: 0 },
        symbol: "none",
        animation: false,
        silent: true,
        z: 1,
        legendHoverLink: false,
      },
      {
        id: `${seriesName}__band_hi`,
        type: "line",
        name: `${seriesName} _hi`,
        stack: `band-${seriesName}`,
        data: agg.map((p) => [xv(p), p.hi - p.lo]),
        lineStyle: { opacity: 0 },
        symbol: "none",
        areaStyle: { color, opacity: 0.18 },
        animation: false,
        silent: true,
        z: 1,
        legendHoverLink: false,
      },
    ];
  }
  // Default: error bars via custom series
  return [
    {
      id: `${seriesName}__ci`,
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
      // Disable transition; animated interpolation can leave the bars
      // stranded a frame behind the matching summary dot during option
      // updates, producing apparent misalignment until the next resize.
      animation: false,
      progressive: 0,
      z: 3,
      silent: true,
      legendHoverLink: false,
    },
  ];
}

/** 构建一个简单的「分面」标题
 *
 *  Encoded as "<X-field>=<X-val> | <Y-field>=<Y-val>" so the user can read
 *  both facet axes off a panel header when a Trellis grid is active.
 *  Either key may be null when only one facet axis is bound. */
function facetTitle(
  xKey: string | null,
  yKey: string | null,
  encoding: GraphSpec["encoding"],
): string {
  const parts: string[] = [];
  if (encoding.groupX && xKey !== null) parts.push(`${encoding.groupX.name}=${xKey}`);
  if (encoding.groupY && yKey !== null) parts.push(`${encoding.groupY.name}=${yKey}`);
  return parts.join(" | ");
}

/** Shared axis ranges computed across the FULL faceted dataset.
 *
 *  When `buildGraph` splits data into multiple panels, each panel's
 *  subset has its own min/max — left unconstrained, ECharts auto-scales
 *  each axis independently, so the same numeric value lands at different
 *  pixel heights across panels. That makes side-by-side comparison
 *  visually misleading (the exact failure mode the user called out:
 *  "严重的判断失误"). The faceted caller therefore pre-computes the
 *  global bounds once over the full dataset and forwards them here so
 *  every panel pins its axes to the same range. */
interface SharedAxisRanges {
  /** Forced numeric min/max for the X axis (value or time type). */
  xMin?: number;
  xMax?: number;
  /** Union of all X categories across panels — used when xAxis.type ===
   *  "category" so missing categories still occupy the same slot on each
   *  panel's axis. */
  xCats?: string[];
  /** Forced numeric min/max for the Y axis (always value type). */
  yMin?: number;
  yMax?: number;
}

/** Map our `RefLineStyle` enum to ECharts' `lineStyle.type`. */
function refDashFor(style: RefLineStyle): "solid" | "dashed" | "dotted" {
  if (style === "dashed") return "dashed";
  if (style === "dotted") return "dotted";
  return "solid";
}

/** Build an invisible scatter "carrier" series whose only job is to host
 *  user-defined Y-axis `markLine`s. We attach the markLines to a series
 *  that has no data points so they always render regardless of which
 *  data elements (points / line / boxplot …) the user has enabled or
 *  hidden. Returns null when no reference lines are configured so we
 *  avoid emitting a noise series.
 *
 *  Note: ECharts' markLine reads `data[i].yAxis` for a horizontal line;
 *  `name` becomes the label text, and `lineStyle` / `label` override the
 *  appearance. The `silent: true` flag prevents the markLine from
 *  participating in tooltips or hover halos, which would distract from
 *  the data series. */
function buildRefLinesCarrier(refLines: RefLineY[] | undefined, theme: GraphTheme): any | null {
  if (!refLines || refLines.length === 0) return null;
  const valid = refLines.filter((r) => Number.isFinite(r.y));
  if (valid.length === 0) return null;
  return {
    id: "__ref_lines_y__",
    type: "scatter",
    name: "",
    data: [],
    // Keep this series out of the legend the renderer might one day
    // surface (we already disable the in-chart legend, but this is
    // defensive in case that changes).
    legendHoverLink: false,
    silent: true,
    z: 5,
    markLine: {
      symbol: ["none", "none"],
      silent: true,
      animation: false,
      // Per-line styling is encoded into each data entry via `lineStyle`
      // and `label`; the series-level defaults below are just fallbacks.
      label: {
        show: true,
        position: "insideEndTop",
        color: theme.fgPrimary,
        fontSize: 11,
      },
      lineStyle: { color: theme.fgPrimary, width: 1, type: "dashed" },
      data: valid.map((r) => {
        const hasLabel = r.label != null && r.label !== "";
        return {
          yAxis: r.y,
          name: r.label || "",
          lineStyle: {
            color: r.color,
            width: r.width,
            type: refDashFor(r.style),
          },
          label: {
            show: hasLabel,
            position: "insideEndTop",
            formatter: r.label || "",
            color: r.color,
            fontSize: 11,
          },
        };
      }),
    },
  };
}

/** Build the ECharts yAxis-option fragment that materializes a
 *  user-defined `YAxisConfig`. Returns `{}` when no overrides are set
 *  so the caller can spread it unconditionally without changing the
 *  auto-scaled default. Only emits keys for fields the user has
 *  actually pinned — undefined fields stay auto.
 *
 *  Notes on `scale`: when the user pins `min` or `max` we drop ECharts'
 *  `scale: true` because it's incompatible with explicit bounds (ECharts
 *  would expand them outward). Leaving `scale` to the caller means our
 *  fragment only adds behavior, never silently removes it. */
function buildYAxisOverrides(cfg: YAxisConfig | undefined): EChartsOption {
  if (!cfg) return {};
  const out: EChartsOption = {};
  if (Number.isFinite(cfg.min as number)) out.min = cfg.min;
  if (Number.isFinite(cfg.max as number)) out.max = cfg.max;
  // Tick increment: ECharts' `interval` is the exact value distance
  // between adjacent major ticks. Floats are allowed (e.g. 0.5 ticks
  // every half unit). We guard against non-positive values, which
  // would either crash ECharts or produce an infinite tick loop.
  if (Number.isFinite(cfg.tickInterval as number) && (cfg.tickInterval as number) > 0) {
    out.interval = cfg.tickInterval;
  }
  if (cfg.inverse === true) out.inverse = true;
  // Decimal precision: format every numeric tick with the requested
  // number of decimal places. Strings (rare on a value axis) pass
  // through unchanged so we don't corrupt category fallbacks.
  if (Number.isFinite(cfg.decimals as number) && (cfg.decimals as number) >= 0) {
    const d = Math.max(0, Math.round(cfg.decimals as number));
    out.axisLabel = {
      formatter: (v: number | string) => (typeof v === "number" ? v.toFixed(d) : String(v)),
    };
  }
  // When the user explicitly pins a bound, disable ECharts' `scale: true`
  // so the pinned value isn't padded outward. The caller spreads our
  // overrides AFTER its own defaults, so setting `scale: false` here
  // correctly overrides the upstream `scale: true`.
  if (out.min !== undefined || out.max !== undefined) {
    out.scale = false;
  }

  // ----- Axis boundary line + tick orientation ------------------------
  // The single "Show axis line & ticks" checkbox in the dialog flips
  // both the axis boundary line and the tick marks together: if either
  // is hidden the user loses the visual frame, so we keep them as one
  // toggle in the UI and mirror that here. axisTick.inside (tick
  // position) still rides on top of show==true.
  if (cfg.showAxisLine !== undefined) {
    out.axisLine = { show: cfg.showAxisLine };
    out.axisTick = { show: cfg.showAxisLine };
  }
  // Tick position is only meaningful when ticks are visible — ECharts
  // ignores `axisTick.inside` quietly if the line is hidden, so emitting
  // it unconditionally is harmless. We still gate on the user actually
  // selecting a non-default value to keep the option object minimal.
  if (cfg.tickPosition === "inside") {
    out.axisTick = { ...(out.axisTick as object | undefined), inside: true };
  } else if (cfg.tickPosition === "outside") {
    out.axisTick = { ...(out.axisTick as object | undefined), inside: false };
  }

  // ----- Minor ticks --------------------------------------------------
  // The user-facing input means "how many visible minor tick marks sit
  // between two adjacent major ticks". ECharts' `minorTick.splitNumber`
  // is the number of *segments* the major interval is divided into,
  // which renders splitNumber-1 visible minor ticks (the endpoints are
  // already the majors). So we translate by adding 1, e.g. user N=2
  // yields splitNumber=3 → exactly 2 minor ticks visible. 0/undefined
  // → minor ticks stay hidden.
  if (Number.isFinite(cfg.minorTickCount as number) && (cfg.minorTickCount as number) > 0) {
    const visible = Math.max(1, Math.round(cfg.minorTickCount as number));
    out.minorTick = {
      show: true,
      splitNumber: visible + 1,
    };
  }

  // ----- Major / minor split lines (grid) -----------------------------
  // Each branch only emits when the user has touched the toggle or
  // styled the lines, so completely-unset configs preserve the theme's
  // splitLine default (visible, dashed gray major; hidden minor).
  if (cfg.showMajorGrid !== undefined || cfg.majorGridStyle) {
    out.splitLine = buildGridLineFragment(cfg.showMajorGrid, cfg.majorGridStyle);
  }
  if (cfg.showMinorGrid !== undefined || cfg.minorGridStyle) {
    out.minorSplitLine = buildGridLineFragment(cfg.showMinorGrid, cfg.minorGridStyle);
  }

  return out;
}

/** Translate a (show, style) pair into an ECharts `splitLine`-shaped
 *  fragment. When `show` is undefined the fragment omits the `show`
 *  field so the caller's upstream defaults win; the style sub-fields
 *  similarly only appear when the user has set them, so each lineStyle
 *  key falls back to the theme. */
function buildGridLineFragment(
  show: boolean | undefined,
  style: GridLineStyle | undefined,
): EChartsOption {
  const out: EChartsOption = {};
  if (show !== undefined) out.show = show;
  if (style) {
    const ls: EChartsOption = {};
    if (style.color) ls.color = style.color;
    if (Number.isFinite(style.width as number) && (style.width as number) > 0) {
      ls.width = style.width;
    }
    if (style.style) ls.type = refDashFor(style.style);
    if (Object.keys(ls).length > 0) out.lineStyle = ls;
  }
  return out;
}

/** Shallow-merge the base ECharts yAxis option with a user-overrides
 *  fragment, taking care to *deep-merge* the small set of nested
 *  objects that both sides can populate. Without this merge a user's
 *  `axisLine: { show: true }` would wipe out the base's
 *  `axisLine: { lineStyle: { color } }` and the axis would render in
 *  the wrong color; same hazard for `axisTick`, `axisLabel`,
 *  `splitLine`, and `minorSplitLine`. */
function mergeYAxis(base: EChartsOption, userY: EChartsOption): EChartsOption {
  const NESTED = ["axisLine", "axisTick", "axisLabel", "splitLine", "minorSplitLine"] as const;
  const merged: EChartsOption = { ...base, ...userY };
  for (const key of NESTED) {
    const b = base[key] as EChartsOption | undefined;
    const u = userY[key] as EChartsOption | undefined;
    if (b && u) {
      // Deep-merge the immediate children; both sides typically only
      // populate `show`, `inside`, and `lineStyle`, so a one-level deep
      // merge of `lineStyle` is enough.
      const childMerged: EChartsOption = { ...b, ...u };
      const bls = (b as { lineStyle?: EChartsOption }).lineStyle;
      const uls = (u as { lineStyle?: EChartsOption }).lineStyle;
      if (bls && uls) {
        (childMerged as { lineStyle?: EChartsOption }).lineStyle = { ...bls, ...uls };
      }
      merged[key] = childMerged;
    }
  }
  return merged;
}

/** 渲染一个单图（不分面）的 ECharts option
 *
 *  When called from the faceted path (`buildGraph` with `groupX`/`wrap`),
 *  each panel only sees its own subset of rows — so the panel-local
 *  ordering of overlay groups can collapse to a single group. Without
 *  `globalGroupKeys`, every panel would then pick color[0] and lose the
 *  per-group theming. Passing the full-dataset ordering keeps EV1 = blue,
 *  TC1.6 = orange, … across every panel.
 *
 *  `sharedRanges` is set by the faceted caller to force every panel to
 *  the same axis bounds (see SharedAxisRanges above). */
function buildSingleOption(
  spec: GraphSpec,
  data: GraphData,
  theme: GraphTheme,
  globalGroupKeys?: string[],
  valueOrders?: Record<string, string[]>,
  sharedRanges?: SharedAxisRanges,
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
  // Y-only fallback collapses all points onto a single category position.
  // Box plots also force a category axis (their categories come from the
  // unique values in `xField`, or a single bucket if no X is bound).
  const useRowIdxX = !xField;
  const hasBoxplot = elements.some((e) => e.kind === "boxplot" && e.enabled !== false);
  const xIsCategory =
    useRowIdxX || hasBoxplot ||
    xField?.type === "nominal" || xField?.type === "ordinal";
  const xIsTime = !useRowIdxX && !hasBoxplot && xField?.type === "datetime";

  const axis = buildAxisCommon(theme);

  const series: any[] = [];

  // 按 color/overlay 分组
  const grouping = colorField || overlayField;
  const rawGroups = groupBy(data, grouping);
  // Respect Value Order on the grouping column so the legend and color
  // assignment follow the user-defined order. With no grouping field this
  // is a no-op (the map has a single "__all__" key).
  const groupingOrder = grouping ? valueOrders?.[grouping.name] : undefined;
  let groups = reorderMapByValueOrder(rawGroups, groupingOrder);

  // Drop groups with no plottable rows under the bound encodings — i.e.
  // every row of the group has a missing value in some encoded channel
  // ({x, y}). This keeps the legend, color indexing, and downstream
  // series iteration in lock-step with GraphBuilderView.groupKeys, which
  // applies the same predicate so an "all-Y-null" overlay value never
  // produces a dead legend swatch with nothing on the canvas.
  // We skip this prune when there is no grouping field (the lone
  // "__all__" bucket must survive even if rows are missing some channel).
  if (grouping) {
    const xIdxCheck = colIndex(data, xField?.name);
    const yIdxCheck = colIndex(data, yField?.name);
    const pruned = new Map<string, number[]>();
    for (const [k, idxs] of groups) {
      const hasPlottable = idxs.some((i) => {
        const row = data.rows[i];
        if (xIdxCheck >= 0 && isMissing(row[xIdxCheck])) return false;
        if (yIdxCheck >= 0 && isMissing(row[yIdxCheck])) return false;
        return true;
      });
      if (hasPlottable) pruned.set(k, idxs);
    }
    groups = pruned;
  }
  const groupKeys = Array.from(groups.keys());

  /** Stable color index for a group: prefers the global ordering passed
   *  in by the faceted caller; falls back to the panel-local order. */
  const colorIndexOf = (gKey: string): number => {
    if (globalGroupKeys) {
      const i = globalGroupKeys.indexOf(gKey);
      if (i >= 0) return i;
    }
    return Math.max(0, groupKeys.indexOf(gKey));
  };

  const enabledElements = elements.filter((e) => e.enabled !== false);

  /** Set of group values the user has hidden via the legend show/hide
   *  toggle. Only meaningful when there's a grouping field; ignored
   *  otherwise (a single ungrouped chart has nothing to hide against). */
  const hiddenSet = new Set(spec.hiddenGroups ?? []);
  const isHidden = (gKey: string): boolean =>
    !!grouping && hiddenSet.has(gKey);

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
      const refCarrier = buildRefLinesCarrier(spec.refLinesY, theme);
      if (refCarrier) series.push(refCarrier);
      return {
        backgroundColor: "transparent",
        textStyle: { color: theme.fgPrimary },
        grid: { left: 56, right: 24, top: 32, bottom: 48 },
        // appendToBody + confine: rendering the tooltip into document.body
        // keeps it from briefly enlarging the chart container (which made
        // the parent's overflow:auto flash a 1-px scrollbar at the bottom
        // edge); `confine` then keeps the tooltip inside the chart's
        // bounding box so it still visually anchors to the data point.
        tooltip: { trigger: "axis", confine: true, appendToBody: true },
        xAxis: {
          type: "value",
          name: xField?.name,
          nameLocation: "middle",
          nameGap: 28,
          ...axis,
          // Faceted histograms still benefit from a shared X span so the
          // bin centers are visually comparable across panels.
          ...(sharedRanges?.xMin != null ? { min: sharedRanges.xMin } : {}),
          ...(sharedRanges?.xMax != null ? { max: sharedRanges.xMax } : {}),
        },
        yAxis: mergeYAxis(
          {
            type: "value",
            name: i18n.t("graph.frequency"),
            nameLocation: "middle",
            nameGap: 40,
            ...axis,
          },
          buildYAxisOverrides(spec.yAxis),
        ),
        series,
        animationDuration: 250,
        _binWidth: width, // 调试用
      } as EChartsOption;
    }
  }

  // —— 箱线图：X 分类，Y 连续。作为一个可与点图/线图叠加的图层，
  //   不再 early-return，而是直接 push 到共享的 series 数组中。
  //
  // When an Overlay/Color column is set, the box plot splits into one
  // box series per group, rendered side-by-side within each X category
  // (matching how the right-side legend panel lists those groups). With
  // no grouping we fall back to a single box per X category.
  if (hasBoxplot && yIdx >= 0) {
    const boxEl = enabledElements.find((e) => e.kind === "boxplot")!;
    const opts = boxEl.options;
    const showOutliers = getOpt<boolean>(opts, "outliers", true);
    const boxType = getOpt<string>(opts, "boxType", "outlier");
    const showFiveNum = getOpt<boolean>(opts, "fiveNumberSummary", false);
    const widthProp = Math.max(0, Math.min(1, getOpt<number>(opts, "widthProportion", 0)));

    const xGroups = reorderMapByValueOrder(groupBy(data, xField), xField ? valueOrders?.[xField.name] : undefined);
    const boxCats = Array.from(xGroups.keys());

    // JMP-style: boxes fill most of the category band by default. The pixel
    // cap below is generous (relative to a typical 80–150px bandwidth) so
    // ECharts can grow boxes wide; the user-controlled `widthProp` (0..1)
    // scales an extra padding allowance on top of the wide default.
    const maxBoxPx = 60 + widthProp * 80;

    // Outer iteration: one box series per overlay/color group when grouping
    // is active, otherwise a single "default" series. Each series shares
    // the same X categories so ECharts dodges them within each bucket.
    const boxIterGroups: string[] = grouping ? groupKeys : [DEFAULT_GROUP_KEY];

    boxIterGroups.forEach((gKey) => {
      // Skip groups hidden via the legend show/hide toggle.
      if (isHidden(gKey)) return;
      const groupColor = grouping
        ? theme.categorical[colorIndexOf(gKey) % theme.categorical.length]
        : theme.categorical[0];
      const groupRowSet = grouping ? new Set(groups.get(gKey) ?? []) : null;

      const boxData: Array<[number, number, number, number, number] | { value: string }> = [];
      const outlierPts: Array<[string, number]> = [];
      const labelMarks: Array<{ x: string; y: number; text: string }> = [];

      boxCats.forEach((cat) => {
        let idxs = xGroups.get(cat)!;
        if (groupRowSet) idxs = idxs.filter((i) => groupRowSet.has(i));
        const ys = idxs.map((i) => toNum(data.rows[i][yIdx])).filter(Number.isFinite);
        if (ys.length === 0) {
          // Empty (X-category × overlay-group) cell: emit ECharts'
          // documented missing-data marker `{value: '-'}` so the slot
          // renders as a gap instead of `[0,0,0,0,0]` (which would draw
          // a phantom flat box pinned at y=0). NOTE: a plain `null`
          // crashes whiskerBoxCommon.js — it tries to read `.value` on
          // the data item — so we must keep the object wrapper.
          boxData.push({ value: "-" });
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
            // Single-pass min/max; avoids Math.min/max(...inRange) overflow
            // when a category contains very many in-range points.
            let mn = Infinity;
            let mx = -Infinity;
            for (let i = 0; i < inRange.length; i++) {
              const v = inRange[i];
              if (v < mn) mn = v;
              if (v > mx) mx = v;
            }
            lower = mn;
            upper = mx;
          }
          if (showOutliers) {
            for (const v of ys) {
              if (v < lo || v > hi) outlierPts.push([displayCat(cat), v]);
            }
          }
        }
        boxData.push([lower, q1, med, q3, upper]);
        // Only label the 5-number summary when there's a single box per
        // category — with grouped boxes the labels would overlap.
        if (showFiveNum && !grouping) {
          const dx = displayCat(cat);
          labelMarks.push({ x: dx, y: med, text: `${med.toFixed(2)}` });
          labelMarks.push({ x: dx, y: q1, text: `Q1 ${q1.toFixed(2)}` });
          labelMarks.push({ x: dx, y: q3, text: `Q3 ${q3.toFixed(2)}` });
        }
      });

      // The box body uses the group's `fill` sub-mark; the box border /
      // median / whisker line use the `line` sub-mark. Outliers use the
      // group's `point` sub-mark.
      const styleKey = grouping ? gKey : DEFAULT_GROUP_KEY;
      const boxGroupStyle = resolveGroupStyle(styleKey, groupColor, !!grouping, theme, spec.styles);
      // Box plots are special: the fill IS the primary mark, not an
      // overlay on top of a stroke layer (as with points / lines / bars).
      // `resolveGroupStyle` defaults ungrouped fill to "transparent" to
      // preserve the JMP scatter/line look, which renders boxes invisible
      // in single-color box plots. Substitute a visible default when the
      // user hasn't explicitly set a fill — chosen so that the cleared /
      // post-Reset rendering is *identical* to applying the first preset
      // theme (theme[0]) in the panel:
      //   - Grouped: lighten each group's categorical color (per-group
      //     differentiation; matches how grouped legend swatches resolve).
      //   - Ungrouped: shade('#000000', 0.55) = FILL_PALETTE[0], i.e. the
      //     exact fill color that theme[0] would write. Using
      //     theme.fgPrimary here instead produced a slightly different
      //     grey (#9898a1 vs #8c8c8c) which made Reset look like it
      //     produced a *different* state than the swatch-highlighted theme.
      //  User overrides from the Fill picker (or an applied theme) still
      //  win because `hasUserFill` short-circuits both branches.
      const userFill = spec.styles?.[styleKey]?.fill;
      const hasUserFill = !!(userFill?.color ?? userFill?.fillColor);
      const neutralBoxFill = shade("#000000", SHADE_RATIO_FILL);
      const effectiveBoxFillColor = hasUserFill
        ? boxGroupStyle.fill.color
        : grouping
          ? shade(groupColor, SHADE_RATIO_FILL)
          : neutralBoxFill;
      const seriesName = grouping ? gKey : (yField?.name ?? "");

      series.push({
        type: "boxplot",
        name: seriesName,
        data: boxData,
        boxWidth: [10, maxBoxPx],
        // ECharts' top-level `itemStyle.opacity` applies to *both* the
        // fill color and the border, so we bake the per-mark alphas into
        // the colors themselves via rgba() and leave `opacity` unset.
        // Result: Fill opacity affects only the box body; Line opacity
        // affects only the box border / median / whiskers.
        itemStyle: {
          color: withAlpha(effectiveBoxFillColor, boxGroupStyle.fill.opacity),
          borderColor: withAlpha(boxGroupStyle.line.color, boxGroupStyle.line.opacity),
          borderWidth: boxGroupStyle.line.width,
        },
        z: 1,
      });
      if (outlierPts.length > 0) {
        series.push({
          type: "scatter",
          // Attach outliers to the parent group's legend entry so toggling
          // the group in the legend hides its outliers too.
          name: seriesName,
          data: outlierPts,
          symbolSize: boxGroupStyle.outlier.size,
          // Outliers default to a small gray dot when ungrouped (JMP look);
          // when grouped, they inherit the group's point color so the
          // viewer can tell which group an extreme value belongs to.
          itemStyle: { color: boxGroupStyle.outlier.color, opacity: boxGroupStyle.outlier.opacity },
          z: 3,
        });
      }
      if (labelMarks.length > 0) {
        series.push({
          type: "scatter",
          name: "5-Number",
          data: labelMarks.map((l) => [l.x, l.y]),
          symbolSize: 0.1,
          label: {
            show: true,
            position: "right",
            color: theme.fgSecondary,
            fontSize: 10,
            formatter: (params: any) => labelMarks[params.dataIndex]?.text ?? "",
          },
          silent: true,
          z: 4,
        });
      }
    });
  }

  // —— 通用 X-Y 元素：points / line / bar / smoother ——
  groupKeys.forEach((gKey) => {
    // Skip groups hidden via the legend show/hide toggle.
    if (isHidden(gKey)) return;
    const color = theme.categorical[colorIndexOf(gKey) % theme.categorical.length];
    const rowIdxs = groups.get(gKey)!;
    const seriesName = grouping ? gKey : (yField?.name || "");

    // Resolve {line, fill, point, outlier} for this group exactly once.
    // The per-element renderers below pull from this resolved style so
    // changing it in the UI affects every active layer simultaneously.
    const styleKey = grouping ? gKey : DEFAULT_GROUP_KEY;
    const resolvedStyle = resolveGroupStyle(styleKey, color, !!grouping, theme, spec.styles);

    enabledElements.forEach((el) => {
      const built = buildElementSeries(el, rowIdxs, data, {
        xIdx,
        yIdx,
        sizeIdx,
        xIsCategory,
        xIsTime,
        seriesName,
        color,
        grouping: !!grouping,
        theme,
        style: resolvedStyle,
      });
      if (built) series.push(...built);
    });
  });

  // The X/Y slot chips outside the canvas already label the axes, so we
  // intentionally omit `name` on the ECharts axes to avoid duplication.
  const rawXCats = useRowIdxX ? [""] : xIsCategory ? collectCategories(data, xIdx) : [];
  const localXCats = xField ? applyValueOrder(rawXCats, valueOrders?.[xField.name]) : rawXCats;
  // When the faceted caller forwards a global category union, use it as
  // the axis spine instead of the panel-local list — keeps every panel
  // aligned to the same X positions even when this subset is missing
  // some categories. Tick label sizing (rotate/wrap) is still driven by
  // the actual rendered category list so it accounts for the widest
  // label that will appear.
  const xCats = xIsCategory && sharedRanges?.xCats ? sharedRanges.xCats : localXCats;
  // Compute rotation / wrap metrics first so the axis literal can reference them.
  const xMaxLines = xIsCategory ? maxWrapLines(xCats, 16) : 1;
  // Rotate only when wrapping doesn't already break long labels onto
  // multiple lines — wrapped labels read better horizontally.
  const xRotated = xIsCategory && xMaxLines === 1 && needsRotation(xCats);
  const bottomGap = xIsCategory
    ? (xRotated ? 56 : 16) + Math.max(0, xMaxLines - 1) * 14
    : 28;
  const xAxis = xIsCategory
    ? {
        type: "category",
        // 收集所有 X 类目（按出现顺序）
        data: xCats,
        ...axis,
        axisLabel: {
          ...(axis.axisLabel as object),
          // Force every category label to render — ECharts otherwise hides
          // overlapping ones, which can drop most ticks for long names.
          interval: 0,
          rotate: xRotated ? 30 : 0,
          hideOverlap: false,
          // Wrap long labels onto multiple lines instead of truncating with "…".
          formatter: (v: string) => wrapLabel(v, 16),
          lineHeight: 13,
        },
      }
    : xIsTime
      ? {
          type: "time",
          ...axis,
          // Pin to shared bounds when faceted so every panel's time axis
          // covers the same span.
          ...(sharedRanges?.xMin != null ? { min: sharedRanges.xMin } : {}),
          ...(sharedRanges?.xMax != null ? { max: sharedRanges.xMax } : {}),
        }
      : {
          type: "value",
          scale: true,
          ...axis,
          // Pin to shared bounds when faceted (see SharedAxisRanges).
          ...(sharedRanges?.xMin != null ? { min: sharedRanges.xMin } : {}),
          ...(sharedRanges?.xMax != null ? { max: sharedRanges.xMax } : {}),
        };

  // Append user-defined Y-axis reference lines (specs limits, target
  // values, thresholds). Goes last so its z-index sits above the data
  // series; the carrier itself is invisible — only the markLines render.
  {
    const refCarrier = buildRefLinesCarrier(spec.refLinesY, theme);
    if (refCarrier) series.push(refCarrier);
  }

  return {
    backgroundColor: "transparent",
    textStyle: { color: theme.fgPrimary },
    // The legend panel on the right already enumerates every group with
    // its color swatch — drawing a second legend strip on top of the
    // canvas is redundant and steals vertical space. Always reserve the
    // small 16-px top margin so titles / tooltips have headroom.
    grid: { left: 52, right: 16, top: 16, bottom: bottomGap },
    // See histogram path above — appendToBody avoids the bottom-edge
    // scrollbar flash; confine keeps the tooltip glued to the chart area.
    tooltip: { trigger: "item", confine: true, appendToBody: true },
    // No in-chart legend: the right-side STYLE panel owns group identity.
    // Series still carry `name` so tooltips and exports stay labeled.
    legend: undefined,
    xAxis,
    yAxis: mergeYAxis(
      {
        type: "value",
        scale: true,
        ...axis,
        // Pin to shared bounds when faceted so every panel's Y axis covers
        // exactly the same range — the whole point of small multiples.
        ...(sharedRanges?.yMin != null ? { min: sharedRanges.yMin } : {}),
        ...(sharedRanges?.yMax != null ? { max: sharedRanges.yMax } : {}),
      },
      buildYAxisOverrides(spec.yAxis),
    ),
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

/** Map the internal placeholder used by groupBy when no field is provided
 *  to an empty display string so the user doesn't see it on the axis. */
function displayCat(cat: string): string {
  return cat === "__all__" ? "" : cat;
}

/** Decide if category labels should be rotated to avoid overlap.
 *  Heuristic: rotate when there are many categories or any label is long. */
function needsRotation(cats: string[]): boolean {
  if (cats.length > 8) return true;
  return cats.some((c) => c.length > 10);
}

/** Wrap a long category label across multiple lines using "\n".
 *  Prefers splitting at common separators (` `, `-`, `_`, `/`) to keep
 *  word boundaries; falls back to a hard chunk split for solid strings. */
function wrapLabel(s: string, maxChars: number): string {
  if (!s) return s;
  if (s.length <= maxChars) return s;
  const tokens = s.split(/(?<=[\s\-_/])/); // keep separators with prev token
  const lines: string[] = [];
  let line = "";
  for (const tok of tokens) {
    if ((line + tok).length > maxChars && line.length > 0) {
      lines.push(line);
      line = tok;
    } else {
      line += tok;
    }
    // If a single token is itself longer than maxChars, hard-break it.
    while (line.length > maxChars) {
      lines.push(line.slice(0, maxChars));
      line = line.slice(maxChars);
    }
  }
  if (line) lines.push(line);
  return lines.map((l) => l.trim()).join("\n");
}

/** Number of wrapped lines the longest label will produce. */
function maxWrapLines(cats: string[], maxChars: number): number {
  let m = 1;
  for (const c of cats) {
    const n = wrapLabel(c, maxChars).split("\n").length;
    if (n > m) m = n;
  }
  return m;
}

interface BuildCtx {
  xIdx: number;
  yIdx: number;
  sizeIdx: number;
  xIsCategory: boolean;
  xIsTime: boolean;
  seriesName: string;
  /** Categorical color of the current group (used as a fallback for any
   *  sub-mark that didn't get an explicit override). */
  color: string;
  /** True when a Color/Overlay split produces multiple series. */
  grouping: boolean;
  theme: GraphTheme;
  /** Resolved {line, fill, point, outlier} sub-marks for the current group.
   *  Every series rendered for this element should pull from these. */
  style: ResolvedGroupStyle;
}

function buildElementSeries(
  el: ChartElement,
  rowIdxs: number[],
  data: GraphData,
  ctx: BuildCtx,
): any[] | null {
  const { xIdx, yIdx, sizeIdx, xIsCategory, seriesName, style } = ctx;
  if (yIdx < 0) return null;

  // When no X column is bound, collapse all points onto a single category
  // so the user sees the Y distribution as a strip / single column.
  const useRowIdx = xIdx < 0;
  const SINGLE_X = "";

  // 取 (x, y[, size]) 数组
  const points: Array<{ x: unknown; y: number; size?: number }> = [];
  for (const i of rowIdxs) {
    const xv = useRowIdx ? SINGLE_X : data.rows[i][xIdx];
    // When a real X column is bound, drop rows whose X is missing so
    // they don't appear as a blank category (bar) or as NaN points
    // (which ECharts plots at the axis origin on a value scale).
    if (!useRowIdx && isMissing(xv)) continue;
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
      if (summaryStat !== "none" && !useRowIdx && xIdx >= 0) {
        const agg = aggregatePoints(
          rowIdxs, data, xIdx, yIdx, xIsCategory, summaryStat, errorInterval,
        );
        const sym = markerToSymbol(style.point.marker);
        const out: any[] = [
          {
            id: `${seriesName}__summary`,
            type: "scatter",
            name: seriesName,
            symbol: sym.symbol,
            // Summary dots are slightly larger than raw scatter dots so
            // they read as the “mean / median” marker on top of the points.
            symbolSize: style.point.size + 3,
            itemStyle: pointItemStyle(style.point, sym.hollow),
            data: agg.map((p) =>
              xIsCategory ? [toStr(p.x), p.y] : [toNum(p.x), p.y],
            ),
            // Disable transition so the dot doesn't lag behind the matching
            // error interval / band when the chart option is replaced.
            animation: false,
            z: 4,
          },
        ];
        // Error bars / band inherit the line sub-mark color so they match
        // any line layer rendered on top.
        out.push(...buildIntervalSeries(agg, xIsCategory, intervalStyle, style.line.color, seriesName));
        return out;
      }

      // Raw scatter (no aggregation). Optional size encoding.
      let sizes: number[] | null = null;
      if (sizeIdx >= 0) {
        const ss = points.map((p) => p.size ?? NaN).filter(Number.isFinite);
        if (ss.length > 0) {
          // Single-pass min/max; avoids Math.min/max(...ss) overflow on
          // scatter plots with very many points.
          let min = Infinity;
          let max = -Infinity;
          for (let i = 0; i < ss.length; i++) {
            const v = ss[i];
            if (v < min) min = v;
            if (v > max) max = v;
          }
          const range = max - min || 1;
          sizes = points.map((p) =>
            Number.isFinite(p.size!) ? 6 + ((p.size! - min) / range) * 22 : 6,
          );
        }
      }

      // Per-point horizontal jitter so overlapping observations are visible.
      // "auto" → JMP-style stack jitter (deterministic, bin Y, spread side
      //   by side around the X position). Best for reading every point.
      // "uniform" / "normal" → random pixel offset of the requested span.
      // "none" → no offset (points overlap).
      const jitterMode = getOpt<string>(opts, "jitter", "auto");
      const jitterLimit = Math.max(0, Math.min(1, getOpt<number>(opts, "jitterLimit", 0.5)));
      const offsets = computeJitterOffsets(points, jitterMode, jitterLimit);

      const sym = markerToSymbol(style.point.marker);
      return [
        {
          type: "scatter",
          name: seriesName,
          symbol: sym.symbol,
          symbolSize: sizes ? (_val: any, params: any) => sizes![params.dataIndex] : style.point.size,
          itemStyle: pointItemStyle(style.point, sym.hollow),
          data: points.map((p, i) => {
            const value = xIsCategory ? [toStr(p.x), p.y] : [toNum(p.x), p.y];
            const off = offsets ? offsets[i] : null;
            return off ? { value, symbolOffset: off } : value;
          }),
          z: 5,
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
      const useAgg = summaryStat !== "none" && !useRowIdx && xIdx >= 0;
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
        intervalSeries = buildIntervalSeries(agg, xIsCategory, intervalStyle, style.line.color, seriesName);
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
        lineStyle: { color: style.line.color, width: style.line.width, opacity: style.line.opacity },
        itemStyle: { color: style.line.color },
        data: lineData,
        z: 2,
      };
      if (fill === "toZero") {
        // Area fill follows the group's fill sub-mark.
        lineSeries.areaStyle = { color: style.fill.color, opacity: style.fill.opacity * 0.5 };
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
          itemStyle: {
            color: style.fill.color,
            borderColor: style.line.color,
            borderWidth: style.line.width,
            opacity: style.fill.opacity,
          },
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
          lineStyle: { color: style.line.color, width: style.line.width, type: "solid", opacity: style.line.opacity },
          itemStyle: { color: style.line.color },
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
 *
 * Layout rules:
 *   - No facet         → 1 panel, 1×1.
 *   - groupX only      → 1 row × N cols (panels laid out left-to-right;
 *                        they visually "share" the Y axis).
 *   - groupY only      → N rows × 1 col (panels stacked top-to-bottom;
 *                        they visually "share" the X axis). Matches
 *                        JMP's Group Y semantics.
 *   - groupX × groupY  → Ny rows × Nx cols Trellis grid (row-major).
 *   - wrap only        → falls back to the legacy sqrt-grid auto wrap.
 *   - wrap is ignored when either groupX or groupY is bound (the
 *     explicit facet axes take precedence).
 */
export interface BuiltGraph {
  /** 子图列表（无分面时长度为 1，row-major: rows top→bottom × cols left→right） */
  panels: {
    title: string;
    option: EChartsOption;
    /** Per-panel facet labels (null when that axis isn't faceted). Used
     *  by the renderer to draw row / column header strips around the grid. */
    groupXValue: string | null;
    groupYValue: string | null;
  }[];
  /** 网格列数（用于布局） */
  cols: number;
  /** 网格行数（用于布局） */
  rows: number;
}

/** Collect facet category keys in their natural-occurrence order, honouring
 *  any user-defined Value Order on the column. */
function collectFacetKeys(
  data: GraphData,
  field: FieldRef,
  valueOrders?: Record<string, string[]>,
): string[] | null {
  const idx = colIndex(data, field.name);
  if (idx < 0) return null;
  const seen: string[] = [];
  const seenSet = new Set<string>();
  for (const r of data.rows) {
    const k = toStr(r[idx]);
    if (!seenSet.has(k)) {
      seenSet.add(k);
      seen.push(k);
    }
  }
  return applyValueOrder(seen, valueOrders?.[field.name]);
}

/** Compute shared X / Y axis ranges across the FULL faceted dataset.
 *
 *  Faceting splits the rows into per-panel subsets whose local min/max
 *  almost always differ. With per-panel auto-scale, the same Y value
 *  lands at a different pixel height in each panel — exactly the failure
 *  mode the user flagged ("严重的判断失误"). Pinning every panel's axes
 *  to the global bounds restores cross-panel comparability.
 *
 *  - Y is always a value axis (histograms aside) — emit numeric min/max.
 *  - X depends on the column type:
 *      * nominal/ordinal → union of categories (so missing categories
 *        still occupy the same slot on every panel)
 *      * datetime → numeric min/max in ms-since-epoch
 *      * quantitative / unknown → numeric min/max
 *  - A tiny relative pad (~2 %) is added to numeric bounds to keep
 *    points off the axis edge; ECharts' `scale: true` does this
 *    automatically when min/max are unset, so we replicate the feel. */
function computeSharedRanges(
  data: GraphData,
  encoding: GraphSpec["encoding"],
  valueOrders?: Record<string, string[]>,
  hiddenGroups?: string[],
): SharedAxisRanges {
  const out: SharedAxisRanges = {};

  // Resolve the grouping field (color or overlay) and pre-compute the
  // column index + a Set of hidden values so we can cheaply skip rows
  // that belong to a hidden legend group. Hidden rows shouldn't drag the
  // shared axis bounds — otherwise hiding a noisy outlier group does
  // nothing visible because the axes still cover its range.
  const grouping = encoding.color || encoding.overlay;
  const groupingIdx = grouping ? colIndex(data, grouping.name) : -1;
  const hiddenSet = new Set(hiddenGroups ?? []);
  const useHiddenFilter = !!grouping && groupingIdx >= 0 && hiddenSet.size > 0;
  const isRowHidden = (r: unknown[]): boolean => {
    if (!useHiddenFilter) return false;
    const v = r[groupingIdx];
    const k = v == null ? "" : String(v);
    return hiddenSet.has(k);
  };

  const yField = encoding.y;
  if (yField) {
    const yIdx = colIndex(data, yField.name);
    if (yIdx >= 0) {
      let yMin = Infinity;
      let yMax = -Infinity;
      for (const r of data.rows) {
        if (isRowHidden(r)) continue;
        const v = toNum(r[yIdx]);
        if (Number.isFinite(v)) {
          if (v < yMin) yMin = v;
          if (v > yMax) yMax = v;
        }
      }
      if (Number.isFinite(yMin) && Number.isFinite(yMax)) {
        const pad = (yMax - yMin) * 0.02 || Math.abs(yMax) * 0.02 || 1;
        out.yMin = yMin - pad;
        out.yMax = yMax + pad;
      }
    }
  }

  const xField = encoding.x;
  if (xField) {
    const xIdx = colIndex(data, xField.name);
    if (xIdx >= 0) {
      const xIsCat = xField.type === "nominal" || xField.type === "ordinal";
      if (xIsCat) {
        const seen = new Set<string>();
        const cats: string[] = [];
        for (const r of data.rows) {
          if (isRowHidden(r)) continue;
          const k = toStr(r[xIdx]);
          if (!seen.has(k)) {
            seen.add(k);
            cats.push(k);
          }
        }
        out.xCats = applyValueOrder(cats, valueOrders?.[xField.name]);
      } else {
        let xMin = Infinity;
        let xMax = -Infinity;
        for (const r of data.rows) {
          if (isRowHidden(r)) continue;
          const raw = r[xIdx];
          const v = xField.type === "datetime"
            ? (raw instanceof Date ? raw.getTime() : new Date(raw as string).getTime())
            : toNum(raw);
          if (Number.isFinite(v)) {
            if (v < xMin) xMin = v;
            if (v > xMax) xMax = v;
          }
        }
        if (Number.isFinite(xMin) && Number.isFinite(xMax)) {
          const pad = (xMax - xMin) * 0.02 || Math.abs(xMax) * 0.02 || 1;
          out.xMin = xMin - pad;
          out.xMax = xMax + pad;
        }
      }
    }
  }

  return out;
}

export function buildGraph(
  spec: GraphSpec,
  data: GraphData,
  theme: GraphTheme,
  valueOrders?: Record<string, string[]>,
): BuiltGraph {
  const { encoding } = spec;
  const fx = encoding.groupX;
  const fy = encoding.groupY;

  // Compute the global ordering of overlay/color groups across the FULL
  // dataset so each panel can map its local group(s) back to the same
  // color slot. Without this, every panel restarts its group index at 0
  // and the per-group themes set in the legend collapse to a single hue.
  const grouping = encoding.color || encoding.overlay;
  const globalGroupKeys = grouping
    ? applyValueOrder(Array.from(groupBy(data, grouping).keys()), valueOrders?.[grouping.name])
    : undefined;

  // No explicit groupX / groupY — fall through to the legacy single-axis
  // wrap path (handled below).
  if (!fx && !fy) {
    const fw = encoding.wrap;
    if (!fw) {
      return {
        panels: [{
          title: spec.title || "",
          option: buildSingleOption(spec, data, theme, globalGroupKeys, valueOrders),
          groupXValue: null,
          groupYValue: null,
        }],
        cols: 1,
        rows: 1,
      };
    }
    const wrapKeys = collectFacetKeys(data, fw, valueOrders);
    if (!wrapKeys) {
      return {
        panels: [{
          title: spec.title || "",
          option: buildSingleOption(spec, data, theme, globalGroupKeys, valueOrders),
          groupXValue: null,
          groupYValue: null,
        }],
        cols: 1,
        rows: 1,
      };
    }
    const wIdx = colIndex(data, fw.name);
    const cols = Math.max(1, Math.min(4, Math.ceil(Math.sqrt(wrapKeys.length))));
    const rows = Math.max(1, Math.ceil(wrapKeys.length / cols));
    // Pin every wrap panel to the same axis bounds for fair comparison.
    const sharedRanges = computeSharedRanges(data, encoding, valueOrders, spec.hiddenGroups);
    const panels = wrapKeys.map((key) => {
      const subRows = data.rows.filter((r) => toStr(r[wIdx]) === key);
      const subData: GraphData = { columns: data.columns, rows: subRows };
      const subSpec: GraphSpec = {
        ...spec,
        encoding: { ...encoding, wrap: undefined },
      };
      return {
        title: `${fw.name}=${key}`,
        option: buildSingleOption(subSpec, subData, theme, globalGroupKeys, valueOrders, sharedRanges),
        groupXValue: null,
        groupYValue: null,
      };
    });
    return { panels, cols, rows };
  }

  // groupX and/or groupY active — build a 2D Trellis grid. Either axis
  // may be missing, in which case its key list collapses to a single
  // sentinel slot so the cross-product still produces panels.
  const xKeys = fx ? (collectFacetKeys(data, fx, valueOrders) ?? [""]) : [null];
  const yKeys = fy ? (collectFacetKeys(data, fy, valueOrders) ?? [""]) : [null];
  const fxIdx = fx ? colIndex(data, fx.name) : -1;
  const fyIdx = fy ? colIndex(data, fy.name) : -1;

  // Compute global axis bounds once so every Trellis cell pins to the
  // same X / Y range — this is what makes Group Y stacking and Group X
  // tiling actually comparable ("完全相同的 Y 轴坐标"). Hidden legend
  // groups are excluded from the range calc so visible data fills the
  // chart area instead of being squashed by data that never renders.
  const sharedRanges = computeSharedRanges(data, encoding, valueOrders, spec.hiddenGroups);
  const panels: BuiltGraph["panels"] = [];
  // row-major: outer loop = Y (top → bottom rows), inner loop = X
  // (left → right within each row). Matches the CSS grid in <Graph>.
  for (const yKey of yKeys) {
    for (const xKey of xKeys) {
      const subRows = data.rows.filter((r) => {
        if (fx && xKey !== null && toStr(r[fxIdx]) !== xKey) return false;
        if (fy && yKey !== null && toStr(r[fyIdx]) !== yKey) return false;
        return true;
      });
      const subData: GraphData = { columns: data.columns, rows: subRows };
      // Strip the facet encodings from the sub-spec so the inner builder
      // doesn't try to re-facet recursively, and drop `wrap` too — when
      // groupX / groupY are present, wrap is ignored (see header comment).
      const subSpec: GraphSpec = {
        ...spec,
        encoding: { ...encoding, groupX: undefined, groupY: undefined, wrap: undefined },
      };
      panels.push({
        title: facetTitle(xKey, yKey, encoding),
        option: buildSingleOption(subSpec, subData, theme, globalGroupKeys, valueOrders, sharedRanges),
        groupXValue: xKey,
        groupYValue: yKey,
      });
    }
  }

  return {
    panels,
    cols: Math.max(1, xKeys.length),
    rows: Math.max(1, yKeys.length),
  };
}
