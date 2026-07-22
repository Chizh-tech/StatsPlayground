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

/** 曲面网格顶点数（N×N）。 */
const GRID_N = 48;
/** 3D 散点上限。 */
const POINT_CAP = 8000;

/** viridis 色阶（低→高），用于按 Z 值着色。 */
export const VIRIDIS_HEX = ["#440154", "#3b528b", "#21918c", "#5ec962", "#fde725"];

/** 默认渐变两端色（浅蓝 → 深蓝）。 */
const DEFAULT_LOW = "#cfe3ff";
const DEFAULT_HIGH = "#0b3d91";

/** 解析 #rgb / #rrggbb 为 [r,g,b]。 */
function hexToRgb(hex: string): [number, number, number] {
  let h = hex.replace("#", "").trim();
  if (h.length === 3) h = h.split("").map((c) => c + c).join("");
  const n = parseInt(h, 16);
  if (!Number.isFinite(n) || h.length !== 6) return [128, 128, 128];
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
/** 在两端色之间按 t∈[0,1] 线性取色，返回 css rgb。 */
function lerpColor(low: string, high: string, t: number): string {
  const a = hexToRgb(low);
  const b = hexToRgb(high);
  const f = Math.max(0, Math.min(1, t));
  return `rgb(${Math.round(a[0] + (b[0] - a[0]) * f)},${Math.round(a[1] + (b[1] - a[1]) * f)},${Math.round(a[2] + (b[2] - a[2]) * f)})`;
}

type SurfaceStat = "mean" | "median";

interface XYZ { xi: number; yi: number; zi: number }

function colIndices(data: GraphData, x?: string, y?: string, z?: string): XYZ {
  return {
    xi: x ? data.columns.indexOf(x) : -1,
    yi: y ? data.columns.indexOf(y) : -1,
    zi: z ? data.columns.indexOf(z) : -1,
  };
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
  const pointsEl = els.find((e) => e.kind === "points" && e.enabled !== false);
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
  // 每组各自成一张 surface / 一簇 scatter3D。
  const overlay = spec.encoding.overlay;
  const styles = spec.styles ?? {};
  const groupColorFallback = (key: string): string => {
    const s = styles[key];
    return s?.fill?.color || s?.point?.color || s?.line?.color || "#4a6cf7";
  };

  const zIdx = zf ? data.columns.indexOf(zf.name) : -1;

  // 分组列表（首次出现顺序去重）。
  let gi = -1;
  const groups: string[] = [];
  if (overlay) {
    gi = data.columns.indexOf(overlay.name);
    if (gi >= 0) {
      const seen = new Set<string>();
      for (const row of data.rows) {
        const gv = row[gi];
        if (isMissing(gv)) continue;
        const k = String(gv);
        if (!seen.has(k)) { seen.add(k); groups.push(k); }
      }
    }
  }
  const grouped = groups.length > 0 && gi >= 0;

  // 每组的行 + 代表值（Z 均值），用于纯色渐变按全局标尺定深浅。
  interface GInfo { key: string; rows: unknown[][]; meanZ: number }
  const groupInfos: GInfo[] = [];
  if (grouped) {
    for (const gkey of groups) {
      const rows = data.rows.filter((r) => String(r[gi]) === gkey);
      let sum = 0, cnt = 0;
      if (zIdx >= 0) {
        for (const r of rows) {
          const z = Number(r[zIdx]);
          if (Number.isFinite(z)) { sum += z; cnt++; }
        }
      }
      groupInfos.push({ key: gkey, rows, meanZ: cnt ? sum / cnt : 0 });
    }
  }

  // 渐变配置。默认：单图例 → color，多图例 → solid。
  const grad = spec.gradient ?? {};
  const mode: "color" | "solid" = grad.mode ?? (grouped ? "solid" : "color");
  const low = grad.low ?? DEFAULT_LOW;
  const high = grad.high ?? DEFAULT_HIGH;

  // 全局 Z 值范围（所有数据）——彩色渐变（color）标尺默认用它。
  let gZmin = Infinity, gZmax = -Infinity;
  if (zIdx >= 0) {
    for (const r of data.rows) {
      const z = Number(r[zIdx]);
      if (Number.isFinite(z)) { if (z < gZmin) gZmin = z; if (z > gZmax) gZmax = z; }
    }
  }
  // 纯色渐变（solid）标尺默认用各组代表值（均值）范围，铺满深浅两端。
  let meanMin = Infinity, meanMax = -Infinity;
  for (const g of groupInfos) {
    if (g.meanZ < meanMin) meanMin = g.meanZ;
    if (g.meanZ > meanMax) meanMax = g.meanZ;
  }
  const solidMin = grad.min ?? (Number.isFinite(meanMin) ? meanMin : 0);
  const solidMax = grad.max ?? (Number.isFinite(meanMax) ? meanMax : 1);
  const solidSpan = solidMax - solidMin || 1;

  const series: Record<string, unknown>[] = [];
  const legendData: string[] = [];

  const addLayers = (gdata: GraphData, name: string | null, color: string | null) => {
    if (surfaceEl && xf && yf && zf) {
      const s = buildSurfaceData(gdata, xf.name, yf.name, zf.name, GRID_N, stat);
      if (s) {
        series.push({
          type: "surface",
          name: name ?? zf.name,
          data: s.verts,
          // 纯色（有 color）用 lambert 明暗；彩色渐变（无 color）用 color
          // 着色 + visualMap 按顶点 Z 取色。
          shading: color ? "lambert" : "color",
          ...(color ? { itemStyle: { color } } : {}),
          wireframe: { show: false },
        });
      }
    }
    if (pointsEl) {
      const sc = buildScatterData(gdata, xf!.name, yf!.name, zf?.name);
      if (sc) {
        series.push({
          type: "scatter3D",
          name: name ?? (zf?.name ?? "points"),
          data: sc.pts,
          symbolSize: 6,
          ...(color ? { itemStyle: { color, opacity: 0.9 } } : { itemStyle: { opacity: 0.9, borderWidth: 0.5, borderColor: "rgba(0,0,0,0.3)" } }),
        });
      }
    }
  };

  if (grouped) {
    for (const g of groupInfos) {
      // 有 Z：solid → 按全局标尺取渐变纯色；color → null（由 visualMap 着色）。
      // 无 Z：退回该组的样式色（区分不同组）。
      const color =
        zIdx < 0
          ? groupColorFallback(g.key)
          : mode === "solid"
            ? lerpColor(low, high, (g.meanZ - solidMin) / solidSpan)
            : null;
      addLayers({ columns: data.columns, rows: g.rows as unknown[][] }, g.key, color);
      legendData.push(g.key);
    }
  } else {
    // 单组：color → 按 Z 色阶；solid → 单一纯色（取深端）。
    const color = mode === "solid" && zIdx >= 0 ? lerpColor(low, high, 1) : null;
    addLayers(data, null, color);
  }

  if (series.length === 0) {
    return { option: null, hint: { key: "graph.threeD.notEnough", def: "Need at least 3 rows with numeric values." } };
  }

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

  if (grouped) {
    option.legend = {
      type: "scroll",
      data: legendData,
      top: 4,
      textStyle: { color: theme.fgSecondary },
    };
  }

  // 彩色渐变：按 Z 值在 low→high 之间连续着色。
  if (mode === "color" && zIdx >= 0 && gZmax > gZmin) {
    option.visualMap = {
      show: true,
      dimension: 2,
      min: grad.min ?? gZmin,
      max: grad.max ?? gZmax,
      calculable: true,
      realtime: false,
      inRange: { color: [low, high] },
      textStyle: { color: theme.fgDim },
      right: 8,
      top: "center",
    };
  }

  return { option };
}
