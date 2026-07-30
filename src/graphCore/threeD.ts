/**
 * threeD.ts — 基于 echarts-gl 的 3D 场景 option 构建。
 *
 * 由 <Chart3D> 使用。把 GraphSpec（3D 模式 + surface / points 图层）
 * 与列式数据转成 echarts-gl 的 grid3D + series-surface / series-scatter3D
 * option。曲面数据仍在前端做分箱聚合（均值/中位数）+ IDW 填补成规则
 * 网格后交给 echarts-gl（echarts-gl 的 surface 需要规则网格顺序数据）。
 *
 * 由于 echarts-gl 未提供官方 TS 类型，这里的 option 以宽松对象构造，
 * 交给 setOption 时按 echarts 的 core option 处理。
 */

import type { GraphSpec, GraphData } from "./types";
import type { GraphTheme } from "./theme";
import { isMissing } from "./transform";
import { DEFAULT_GROUP_KEY } from "./types";

/** 曲面网格顶点数（N×N）。 */
const GRID_N = 48;
/** 3D 散点上限。 */
const POINT_CAP = 8000;

type SurfaceStat = "mean" | "median";

/** 将 #rrggbb 向黑（ratio<0）或白（ratio>0）混合，ratio∈[-1,1]。 */
function shade(hex: string, ratio: number): string {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return hex;
  const h = m[1];
  const r = parseInt(h.slice(0, 2), 16);
  const g = parseInt(h.slice(2, 4), 16);
  const b = parseInt(h.slice(4, 6), 16);
  const mix = (c: number) => (ratio < 0 ? Math.round(c * (1 + ratio)) : Math.round(c + (255 - c) * ratio));
  const cl = (n: number) => Math.max(0, Math.min(255, n));
  const hx = (n: number) => cl(n).toString(16).padStart(2, "0");
  return `#${hx(mix(r))}${hx(mix(g))}${hx(mix(b))}`;
}

interface XYZ { xi: number; yi: number; zi: number }

function colIndices(data: GraphData, x?: string, y?: string, z?: string): XYZ {
  return {
    xi: x ? data.columns.indexOf(x) : -1,
    yi: y ? data.columns.indexOf(y) : -1,
    zi: z ? data.columns.indexOf(z) : -1,
  };
}

/** 聚合一组 z 值（mean / median / sum）。 */
function aggZ(zs: number[], stat: string): number {
  const n = zs.length;
  if (n === 0) return 0;
  if (stat === "sum") { let s = 0; for (const z of zs) s += z; return s; }
  if (stat === "median") {
    const a = [...zs].sort((p, q) => p - q);
    const m = a.length;
    return m % 2 ? a[(m - 1) / 2] : (a[m / 2 - 1] + a[m / 2]) / 2;
  }
  let s = 0;
  for (const z of zs) s += z;
  return s / n;
}

/** 误差幅度：stdErr / stdDev / ci95（auto → stdErr）。样本 <2 返回 0。 */
function errMagnitude(zs: number[], kind: string): number {
  const n = zs.length;
  if (n < 2) return 0;
  let mean = 0;
  for (const z of zs) mean += z;
  mean /= n;
  let ss = 0;
  for (const z of zs) { const d = z - mean; ss += d * d; }
  const sd = Math.sqrt(ss / (n - 1));
  const se = sd / Math.sqrt(n);
  const k = kind === "auto" ? "stdErr" : kind;
  if (k === "stdDev") return sd;
  if (k === "ci95") return 1.96 * se;
  return se;
}

/** 分箱聚合（mean/median）+ IDW 填补，返回按行优先展开的 [x,y,z] 顶点。 */
function buildSurfaceData(
  data: GraphData,
  xName: string,
  yName: string,
  zName: string,
  n: number,
  stat: SurfaceStat,
): { verts: number[][]; zmin: number; zmax: number } | null {
  const { xi, yi, zi } = colIndices(data, xName, yName, zName);
  if (xi < 0 || yi < 0 || zi < 0) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const row of data.rows) {
    const x = Number(row[xi]);
    const y = Number(row[yi]);
    const z = Number(row[zi]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      xs.push(x); ys.push(y); zs.push(z);
      if (x < xmin) xmin = x; if (x > xmax) xmax = x;
      if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    }
  }
  const p = xs.length;
  if (p < 3) return null;
  const dx = xmax - xmin || 1;
  const dy = ymax - ymin || 1;

  const cells: (number[] | undefined)[] = new Array(n * n);
  for (let k = 0; k < p; k++) {
    let gi = Math.round(((xs[k] - xmin) / dx) * (n - 1));
    let gj = Math.round(((ys[k] - ymin) / dy) * (n - 1));
    if (gi < 0) gi = 0; else if (gi > n - 1) gi = n - 1;
    if (gj < 0) gj = 0; else if (gj > n - 1) gj = n - 1;
    (cells[gj * n + gi] ??= []).push(zs[k]);
  }

  const zg = new Float64Array(n * n);
  const filled = new Uint8Array(n * n);
  const occ: { gi: number; gj: number; v: number }[] = [];
  for (let idx = 0; idx < n * n; idx++) {
    const arr = cells[idx];
    if (!arr || arr.length === 0) continue;
    let v: number;
    if (stat === "median") {
      arr.sort((a, b) => a - b);
      const m = arr.length;
      v = m % 2 ? arr[(m - 1) / 2] : (arr[m / 2 - 1] + arr[m / 2]) / 2;
    } else {
      let s = 0;
      for (const z of arr) s += z;
      v = s / arr.length;
    }
    zg[idx] = v;
    filled[idx] = 1;
    occ.push({ gi: idx % n, gj: Math.floor(idx / n), v });
  }
  if (occ.length === 0) return null;

  for (let gj = 0; gj < n; gj++) {
    for (let gi = 0; gi < n; gi++) {
      const idx = gj * n + gi;
      if (filled[idx]) continue;
      let num = 0, den = 0, exact = NaN;
      for (const o of occ) {
        const ddx = (gi - o.gi) / (n - 1);
        const ddy = (gj - o.gj) / (n - 1);
        const d2 = ddx * ddx + ddy * ddy;
        if (d2 < 1e-9) { exact = o.v; break; }
        const wgt = 1 / (d2 * d2);
        num += wgt * o.v;
        den += wgt;
      }
      zg[idx] = Number.isFinite(exact) ? exact : den > 0 ? num / den : 0;
    }
  }

  const verts: number[][] = [];
  let zmin = Infinity, zmax = -Infinity;
  for (let gj = 0; gj < n; gj++) {
    const yv = ymin + (dy * gj) / (n - 1);
    for (let gi = 0; gi < n; gi++) {
      const xv = xmin + (dx * gi) / (n - 1);
      const zv = zg[gj * n + gi];
      verts.push([xv, yv, zv]);
      if (zv < zmin) zmin = zv;
      if (zv > zmax) zmax = zv;
    }
  }
  return { verts, zmin, zmax };
}

/** 抽取 3D 散点 [x,y,z]（Z 缺省时 z=0）。 */
function buildScatterData(
  data: GraphData,
  xName: string,
  yName: string,
  zName: string | undefined,
): { pts: number[][]; zmin: number; zmax: number } | null {
  const { xi, yi, zi } = colIndices(data, xName, yName, zName);
  if (xi < 0 || yi < 0) return null;
  const pts: number[][] = [];
  let zmin = Infinity, zmax = -Infinity;
  for (const row of data.rows) {
    const x = Number(row[xi]);
    const y = Number(row[yi]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    let z = 0;
    if (zi >= 0) {
      z = Number(row[zi]);
      if (!Number.isFinite(z)) continue;
    }
    pts.push([x, y, z]);
    if (z < zmin) zmin = z; if (z > zmax) zmax = z;
  }
  if (pts.length === 0) return null;
  if (zi < 0) { zmin = 0; zmax = 0; }
  let out = pts;
  if (pts.length > POINT_CAP) {
    out = [];
    const step = pts.length / POINT_CAP;
    for (let i = 0; i < POINT_CAP; i++) out.push(pts[Math.floor(i * step)]);
  }
  return { pts: out, zmin, zmax };
}

export interface Build3DResult {
  /** echarts-gl option（宽松类型）。空表示还不足以渲染。 */
  option: Record<string, unknown> | null;
  /** 无法渲染时的提示 key + 默认文案。 */
  hint?: { key: string; def: string };
}

/** 构建 3D option。当绑定不足时返回 hint。 */
export function build3DOption(spec: GraphSpec, data: GraphData, theme: GraphTheme): Build3DResult {
  const xf = spec.encoding.x;
  const yf = spec.encoding.y;
  const zf = spec.encoding.z;
  const els = spec.elements ?? [];
  const surfaceEl = els.find((e) => e.kind === "surface" && e.enabled !== false);
  const pointsEl = els.find((e) => e.kind === "scatter3d" && e.enabled !== false);
  const stat: SurfaceStat = surfaceEl?.options?.stat === "median" ? "median" : "mean";

  if (!surfaceEl && !pointsEl) {
    return { option: null, hint: { key: "graph.threeD.addSurface", def: "Add a Surface or Scatter layer to render in 3D." } };
  }
  if (!xf || !yf) {
    return { option: null, hint: { key: "graph.threeD.dragXY", def: "Drag columns onto X and Y (and Z) to build a 3D chart." } };
  }
  if (surfaceEl && !zf) {
    return { option: null, hint: { key: "graph.threeD.dragHint", def: "Drag a column onto Z to build a 3D surface." } };
  }

  // 分组：当绑定了 Overlay（图例）列时，按其值把数据切成多组，
  // 每组各自成一张 surface / 一簇 scatter3D，颜色取该组「渐变」标记的
  // 颜色（主题自动为每个图例分配不同色，用户可切换，跟点/线/面一致）。
  const overlay = spec.encoding.overlay;
  const styles = spec.styles ?? {};
  const colorOf = (key: string): string => {
    const s = styles[key];
    return s?.gradient?.color || s?.fill?.color || s?.point?.color || "#4a6cf7";
  };

  const series: Record<string, unknown>[] = [];
  // 记录每组占用的 series 下标 + 名称 + 主题色，之后为每组建一个作
  // 用于这些 series 的 visualMap（右上角渐变条），并着色其曲面/散点。
  const groupSeries: { name: string; color: string; indices: number[] }[] = [];
  const surfIndices: number[] = [];

  // 渐变标尺范围。对 surface plot 用「实际曲面（插值网格）」的
  // 最高/最低（比原始数据范围更紧凑，对比度更高）；无曲面
  // （纯散点）时用散点 Z 范围。
  const hasZ = !!zf;
  let smin = Infinity, smax = -Infinity; // 曲面网格
  let pmin = Infinity, pmax = -Infinity; // 散点

  // 3D 散点设置（继承自 2D 散点）：汇总统计、误差区间、区间样式。
  const scOpts = (pointsEl?.options ?? {}) as Record<string, unknown>;
  const summaryStat = String(scOpts.summaryStat ?? "none");
  const errInterval = String(scOpts.errorInterval ?? "auto");
  const intStyle = String(scOpts.intervalStyle ?? "errorBar") === "band" ? "band" : "errorBar";
  const summarize = summaryStat !== "none" && !!zf;

  const addLayers = (gdata: GraphData, name: string, color: string) => {
    const indices: number[] = [];
    if (surfaceEl && xf && yf && zf) {
      const s = buildSurfaceData(gdata, xf.name, yf.name, zf.name, GRID_N, stat);
      if (s) {
        series.push({
          type: "surface",
          name,
          data: s.verts,
          // hasZ: 用 color 着色，由该组 visualMap 按顶点 Z 取深浅色调（若
          // Z 无有效范围，后面会回退为 lambert）；无 Z 时直接纯色。
          shading: hasZ ? "color" : "lambert",
          itemStyle: { color },
          wireframe: { show: false },
        });
        surfIndices.push(series.length - 1);
        indices.push(series.length - 1);
        if (s.zmin < smin) smin = s.zmin;
        if (s.zmax > smax) smax = s.zmax;
      }
    }
    if (pointsEl && xf && yf) {
      if (!summarize) {
        // 原始散点：全部点，参与深度渐变着色。
        const sc = buildScatterData(gdata, xf.name, yf.name, zf?.name);
        if (sc) {
          series.push({
            type: "scatter3D",
            name,
            data: sc.pts,
            symbolSize: 6,
            itemStyle: { color, opacity: 0.9 },
          });
          indices.push(series.length - 1);
          if (sc.zmin < pmin) pmin = sc.zmin;
          if (sc.zmax > pmax) pmax = sc.zmax;
        }
      } else {
        // 汇总：按 (X, Y) 坐标分箱，每个位置画一个点 (x, y, agg(Z))；
        // 误差沿 Z 方向绘制（误差棒 / 色带），跟 2D 选项一致。
        const xi = gdata.columns.indexOf(xf.name);
        const yi = gdata.columns.indexOf(yf.name);
        const zi = gdata.columns.indexOf(zf!.name);
        const cells = new Map<string, { x: number; y: number; zs: number[] }>();
        for (const r of gdata.rows) {
          const x = Number(r[xi]);
          const y = Number(r[yi]);
          const z = Number(r[zi]);
          if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z)) continue;
          const key = `${x}|${y}`;
          let c = cells.get(key);
          if (!c) { c = { x, y, zs: [] }; cells.set(key, c); }
          c.zs.push(z);
        }
        const pts: number[][] = [];
        const errSegs: number[][][] = [];
        for (const c of cells.values()) {
          const az = aggZ(c.zs, summaryStat);
          pts.push([c.x, c.y, az]);
          if (az < pmin) pmin = az;
          if (az > pmax) pmax = az;
          if (errInterval !== "none") {
            const e = errMagnitude(c.zs, errInterval);
            if (e > 0) {
              errSegs.push([[c.x, c.y, az - e], [c.x, c.y, az + e]]);
              if (az - e < pmin) pmin = az - e;
              if (az + e > pmax) pmax = az + e;
            }
          }
        }
        if (pts.length) {
          // 误差指示（先画，位于点之下）：沿 Z 的多段线；band = 粗且半透明。
          for (let i = 0; i < errSegs.length; i++) {
            series.push({
              type: "line3D",
              coordinateSystem: "cartesian3D",
              name: `${name}__err_${i}`,
              data: errSegs[i],
              lineStyle: {
                color,
                width: intStyle === "band" ? 8 : 2,
                opacity: intStyle === "band" ? 0.28 : 0.9,
              },
              silent: true,
            });
          }
          // 汇总点（纯色 group 色）。
          series.push({
            type: "scatter3D",
            name,
            data: pts,
            symbolSize: 8,
            itemStyle: { color, opacity: 1, borderWidth: 0.5, borderColor: "rgba(0,0,0,0.3)" },
          });
        }
      }
    }
    if (indices.length) groupSeries.push({ name, color, indices });
  };

  let grouped = false;
  if (overlay) {
    const gi = data.columns.indexOf(overlay.name);
    if (gi >= 0) {
      // 首次出现顺序去重分组。
      const seen = new Set<string>();
      const groups: string[] = [];
      for (const row of data.rows) {
        const gv = row[gi];
        if (isMissing(gv)) continue;
        const k = String(gv);
        if (!seen.has(k)) { seen.add(k); groups.push(k); }
      }
      grouped = groups.length > 0;
      // 响应图例面板的「隐藏分组」（眼睛开关）：被隐藏的组不生成任何
      // series，也不出现在图例中——与 2D 行为一致。
      const hidden = new Set(spec.hiddenGroups ?? []);
      for (const gkey of groups) {
        if (hidden.has(gkey)) continue;
        const rows = data.rows.filter((r) => String(r[gi]) === gkey);
        addLayers({ columns: data.columns, rows }, gkey, colorOf(gkey));
      }
    }
  }
  if (!grouped) {
    addLayers(data, zf?.name ?? "series", colorOf(DEFAULT_GROUP_KEY));
  }

  if (series.length === 0) {
    return { option: null, hint: { key: "graph.threeD.notEnough", def: "Need at least 3 rows with numeric values." } };
  }

  // 标尺：有曲面则用曲面网格极值（对比度更高），否则用散点 Z 范围。
  const hasSurfRange = smax > smin;
  const rmin = hasSurfRange ? smin : pmin;
  const rmax = hasSurfRange ? smax : pmax;
  const useDepth = hasZ && rmax > rmin;

  const axisCommon = {
    nameTextStyle: { color: theme.fgSecondary },
    axisLine: { lineStyle: { color: theme.axisLine } },
    axisLabel: { color: theme.fgDim },
    splitLine: { lineStyle: { color: theme.gridLine } },
  };

  const option: Record<string, unknown> = {
    backgroundColor: theme.bgCanvas,
    tooltip: {},
    xAxis3D: { type: "value", name: xf.name, ...axisCommon },
    yAxis3D: { type: "value", name: yf.name, ...axisCommon },
    zAxis3D: { type: "value", name: zf?.name ?? "", ...axisCommon },
    grid3D: {
      boxWidth: 100,
      boxDepth: 100,
      boxHeight: 100,
      axisPointer: { lineStyle: { color: theme.fgDim } },
      viewControl: { autoRotate: false, rotateSensitivity: 1, zoomSensitivity: 1 },
      light: {
        main: { intensity: 1.2, shadow: false, alpha: 40, beta: 40 },
        ambient: { intensity: 0.3 },
      },
    },
    series,
  };

  // 顶部图例：仅当存在 surface 图层（用到渐变着色）时，在右上角画一个
  // 紧凑的自定义图例——每行是「组名 + 一小段渐变色条」。visualMap 只负责
  // 给曲面/散点着色（show:false），图例外观由 graphic 元素精确排版。
  if (useDepth) {
    option.visualMap = groupSeries.map((g) => ({
      type: "continuous",
      show: false,
      dimension: 2,
      seriesIndex: g.indices,
      min: rmin,
      max: rmax,
      inRange: { color: [shade(g.color, -0.4), g.color, shade(g.color, 0.6)] },
    }));

    if (surfaceEl && groupSeries.length > 0) {
      const rowH = 22;
      const top0 = 12;
      const barW = 40;
      const barH = 12;
      // 每行一个 group（右上角锚定），内部子元素用局部 x/y 定位——这样
      // 文字的 textVerticalAlign:middle 相对 y 精确居中，色条与文字对齐。
      const elements = groupSeries.map((g, i) => ({
        type: "group",
        right: 10,
        top: top0 + i * rowH,
        children: [
          {
            type: "text",
            x: -(barW + 6),
            y: barH / 2,
            style: {
              text: g.name,
              textAlign: "right",
              textVerticalAlign: "middle",
              fill: theme.fgSecondary,
              font: "11px sans-serif",
            },
          },
          {
            type: "rect",
            x: -barW,
            y: 0,
            shape: { width: barW, height: barH, r: 2 },
            style: {
              fill: {
                type: "linear",
                x: 0, y: 0, x2: 1, y2: 0,
                colorStops: [
                  { offset: 0, color: shade(g.color, -0.4) },
                  { offset: 0.5, color: g.color },
                  { offset: 1, color: shade(g.color, 0.6) },
                ],
              },
            },
          },
        ],
      }));
      option.graphic = { elements };
    }
  } else {
    // Z 无有效范围：把 color 着色的曲面回退为 lambert 纯色。
    for (const i of surfIndices) (series[i] as Record<string, unknown>).shading = "lambert";
  }

  return { option };
}
