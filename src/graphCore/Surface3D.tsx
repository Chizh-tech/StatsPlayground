/**
 * Surface3D — 自包含（无第三方 3D 依赖）的三维场景渲染器。
 *
 * 由 <Graph> 在「3D 模式且存在支持 3D 的启用图层」时替代 2D ECharts
 * 渲染。支持两类 3D 图层：
 *   - surface 曲面：X/Y/Z 三通道 → 分箱聚合（均值/中位数）→ IDW 填补
 *     → 规则网格，按高度 viridis 着色 + 法线明暗。
 *   - points 3D 散点：每行 (x, y, z) 一个点；未绑定 Z 时 z=0（落在
 *     底平面），绑定后获得高度。
 * 二者可叠加。统一正交投影 + 画家算法（按深度远→近），带坐标轴刻度、
 * 竖向颜色图例，支持鼠标拖动旋转、滚轮缩放。
 *
 * 不用 echarts-gl：当前环境无法安装（TLS 握手失败），且本应用主打
 * 「超轻量」，自绘方案零依赖。
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { GraphSpec, GraphData } from "./types";
import { getGraphTheme, type GraphTheme } from "./theme";
import { useThemeStore } from "@/stores/useThemeStore";

interface Surface3DProps {
  spec: GraphSpec;
  data: GraphData;
}

type SurfaceStat = "mean" | "median";

/** 网格大小（N×N 顶点）。 */
const GRID_N = 40;
/** 3D 散点最多绘制的点数（防卡顿）。 */
const POINT_CAP = 6000;

interface Ranges {
  xmin: number; xmax: number;
  ymin: number; ymax: number;
  zmin: number; zmax: number;
}

interface SurfaceGrid {
  n: number;
  /** 行优先的 z 网格值，长度 n*n（数据空间）。 */
  zg: Float64Array;
  zmin: number; zmax: number;
}

interface ScenePoint { x: number; y: number; z: number }

/** 从数据抽取有限的 (x,y,z) 点。z 通道缺省时全为 0（底平面）。 */
function extractPoints(
  data: GraphData,
  xName: string,
  yName: string,
  zName: string | undefined,
): { pts: ScenePoint[]; ranges: Ranges } | null {
  const xi = data.columns.indexOf(xName);
  const yi = data.columns.indexOf(yName);
  const zi = zName ? data.columns.indexOf(zName) : -1;
  if (xi < 0 || yi < 0) return null;
  const pts: ScenePoint[] = [];
  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity, zmin = Infinity, zmax = -Infinity;
  for (const row of data.rows) {
    const x = Number(row[xi]);
    const y = Number(row[yi]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    let z = 0;
    if (zi >= 0) {
      z = Number(row[zi]);
      if (!Number.isFinite(z)) continue;
    }
    pts.push({ x, y, z });
    if (x < xmin) xmin = x; if (x > xmax) xmax = x;
    if (y < ymin) ymin = y; if (y > ymax) ymax = y;
    if (z < zmin) zmin = z; if (z > zmax) zmax = z;
  }
  if (pts.length === 0) return null;
  if (zi < 0) { zmin = 0; zmax = 1; } // 无 Z：给一个名义范围以便画底平面
  // 下采样绘制。
  let out = pts;
  if (pts.length > POINT_CAP) {
    out = [];
    const step = pts.length / POINT_CAP;
    for (let i = 0; i < POINT_CAP; i++) out.push(pts[Math.floor(i * step)]);
  }
  return { pts: out, ranges: { xmin, xmax, ymin, ymax, zmin, zmax } };
}

/** 从散点 (x,y,z) 按网格分箱聚合（mean/median）构建曲面，空格用 IDW 填补。 */
function buildSurfaceGrid(
  data: GraphData,
  xName: string,
  yName: string,
  zName: string,
  n: number,
  stat: SurfaceStat,
): { grid: SurfaceGrid; ranges: Ranges } | null {
  const xi = data.columns.indexOf(xName);
  const yi = data.columns.indexOf(yName);
  const zi = data.columns.indexOf(zName);
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
    const idx = gj * n + gi;
    (cells[idx] ??= []).push(zs[k]);
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

  let zmin = Infinity, zmax = -Infinity;
  for (let i = 0; i < zg.length; i++) {
    if (zg[i] < zmin) zmin = zg[i];
    if (zg[i] > zmax) zmax = zg[i];
  }
  return { grid: { n, zg, zmin, zmax }, ranges: { xmin, xmax, ymin, ymax, zmin, zmax } };
}

const VIRIDIS: [number, number, number][] = [
  [68, 1, 84], [59, 82, 139], [33, 145, 140], [94, 201, 98], [253, 231, 37],
];
function colormapRGB(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[Math.min(i + 1, VIRIDIS.length - 1)];
  return [a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f, a[2] + (b[2] - a[2]) * f];
}

function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (Math.abs(v) >= 1e5 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3)) return v.toExponential(2);
  return Number(v.toFixed(4)).toString();
}

interface Projected { sx: number; sy: number; depth: number }
interface Vec3 { x: number; y: number; z: number }
function sub(a: Vec3, b: Vec3): Vec3 { return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z }; }
function cross(a: Vec3, b: Vec3): Vec3 {
  return { x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x };
}
function normalize(v: Vec3): Vec3 {
  const m = Math.hypot(v.x, v.y, v.z) || 1;
  return { x: v.x / m, y: v.y / m, z: v.z / m };
}

/** 绘制 3D 场景（可选曲面 + 可选散点，共享 ranges 归一化）。 */
function drawScene(
  canvas: HTMLCanvasElement,
  ranges: Ranges,
  grid: SurfaceGrid | null,
  points: ScenePoint[] | null,
  yaw: number,
  pitch: number,
  zoom: number,
  w: number,
  h: number,
  theme: GraphTheme,
  labels: { x: string; y: string; z: string },
) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.max(1, Math.round(w * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  canvas.style.width = `${w}px`;
  canvas.style.height = `${h}px`;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = theme.bgCanvas;
  ctx.fillRect(0, 0, w, h);

  const dx = ranges.xmax - ranges.xmin || 1;
  const dy = ranges.ymax - ranges.ymin || 1;
  const dz = ranges.zmax - ranges.zmin || 1;
  const cx = w / 2 - 24;
  const cy = h / 2;
  const scale = Math.min(w - 70, h) * 0.6 * zoom;
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch);

  const project = (nx: number, ny: number, nz: number): Projected => {
    const x1 = nx * cosY - ny * sinY;
    const y1 = nx * sinY + ny * cosY;
    const y2 = y1 * cosP - nz * sinP;
    const z2 = y1 * sinP + nz * cosP;
    return { sx: cx + x1 * scale, sy: cy - z2 * scale, depth: y2 };
  };
  const projData = (x: number, y: number, z: number): Projected =>
    project((x - ranges.xmin) / dx - 0.5, (y - ranges.ymin) / dy - 0.5, (z - ranges.zmin) / dz - 0.5);

  // 后置包围盒边。
  drawFrame(ctx, project, theme, labels, ranges, true);

  // 曲面。
  if (grid) {
    const { n, zg } = grid;
    const pos3: Vec3[] = new Array(n * n);
    const proj: Projected[] = new Array(n * n);
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        const nx = i / (n - 1) - 0.5;
        const ny = j / (n - 1) - 0.5;
        const nz = (zg[j * n + i] - ranges.zmin) / dz - 0.5;
        pos3[j * n + i] = { x: nx, y: ny, z: nz };
        proj[j * n + i] = project(nx, ny, nz);
      }
    }
    const L = normalize({ x: -0.5, y: -0.6, z: 0.75 });
    interface Quad { a: Projected; b: Projected; c: Projected; d: Projected; depth: number; z: number; shade: number }
    const quads: Quad[] = [];
    for (let j = 0; j < n - 1; j++) {
      for (let i = 0; i < n - 1; i++) {
        const ia = j * n + i, ib = j * n + i + 1, ic = (j + 1) * n + i + 1, id = (j + 1) * n + i;
        const a = proj[ia], b = proj[ib], c = proj[ic], d = proj[id];
        const depth = (a.depth + b.depth + c.depth + d.depth) / 4;
        const zavg = (zg[ia] + zg[ib] + zg[ic] + zg[id]) / 4;
        const nrm = normalize(cross(sub(pos3[ic], pos3[ia]), sub(pos3[id], pos3[ib])));
        const ndl = Math.abs(nrm.x * L.x + nrm.y * L.y + nrm.z * L.z);
        quads.push({ a, b, c, d, depth, z: zavg, shade: 0.55 + 0.55 * ndl });
      }
    }
    quads.sort((p, q) => q.depth - p.depth);
    for (const qd of quads) {
      const [r, g, bl] = colormapRGB((qd.z - grid.zmin) / (grid.zmax - grid.zmin || 1));
      const s = qd.shade;
      ctx.beginPath();
      ctx.moveTo(qd.a.sx, qd.a.sy);
      ctx.lineTo(qd.b.sx, qd.b.sy);
      ctx.lineTo(qd.c.sx, qd.c.sy);
      ctx.lineTo(qd.d.sx, qd.d.sy);
      ctx.closePath();
      ctx.fillStyle = `rgb(${Math.min(255, Math.round(r * s))},${Math.min(255, Math.round(g * s))},${Math.min(255, Math.round(bl * s))})`;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.08)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  // 3D 散点（画在曲面之上，按深度排序）。
  if (points && points.length) {
    const projected = points.map((p) => {
      const pr = projData(p.x, p.y, p.z);
      return { pr, t: (p.z - ranges.zmin) / dz };
    });
    projected.sort((a, b) => b.pr.depth - a.pr.depth);
    for (const { pr, t } of projected) {
      const [r, g, b] = colormapRGB(t);
      ctx.beginPath();
      ctx.arc(pr.sx, pr.sy, 3, 0, Math.PI * 2);
      ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 0.5;
      ctx.stroke();
    }
  }

  // 前置包围盒边 + 轴标题 + 刻度。
  drawFrame(ctx, project, theme, labels, ranges, false);
  // 竖向颜色图例（按 Z 值）。
  drawLegend(ctx, w, h, theme, ranges.zmin, ranges.zmax);
}

function drawFrame(
  ctx: CanvasRenderingContext2D,
  project: (nx: number, ny: number, nz: number) => Projected,
  theme: GraphTheme,
  labels: { x: string; y: string; z: string },
  ranges: Ranges,
  back: boolean,
) {
  const cube: [number, number, number][] = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  ];
  const corners = cube.map((c) => project(c[0], c[1], c[2]));
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0], [4, 5], [5, 6], [6, 7], [7, 4], [0, 4], [1, 5], [2, 6], [3, 7],
  ];
  const depths = corners.map((c) => c.depth);
  const mid = (Math.max(...depths) + Math.min(...depths)) / 2;

  ctx.strokeStyle = theme.axisLine;
  ctx.lineWidth = 1;
  ctx.globalAlpha = back ? 0.45 : 0.8;
  for (const [a, b] of edges) {
    const isBack = (corners[a].depth + corners[b].depth) / 2 > mid;
    if (isBack !== back) continue;
    ctx.beginPath();
    ctx.moveTo(corners[a].sx, corners[a].sy);
    ctx.lineTo(corners[b].sx, corners[b].sy);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;
  if (back) return;

  ctx.fillStyle = theme.fgDim;
  ctx.font = "10px sans-serif";
  const tick = (
    from: Projected, to: Projected, v0: number, v1: number,
    align: CanvasTextAlign, ox: number, oy: number,
  ) => {
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    for (const f of [0, 0.5, 1]) {
      const sx = from.sx + (to.sx - from.sx) * f + ox;
      const sy = from.sy + (to.sy - from.sy) * f + oy;
      ctx.fillText(fmtNum(v0 + (v1 - v0) * f), sx, sy);
    }
  };
  tick(corners[0], corners[1], ranges.xmin, ranges.xmax, "center", 0, 12);
  tick(corners[1], corners[2], ranges.ymin, ranges.ymax, "left", 8, 0);
  tick(corners[2], corners[6], ranges.zmin, ranges.zmax, "right", -8, 0);

  ctx.fillStyle = theme.fgSecondary;
  ctx.font = "12px sans-serif";
  ctx.textBaseline = "middle";
  const mp = (a: Projected, b: Projected) => ({ sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 });
  const xm = mp(corners[0], corners[1]);
  const ym = mp(corners[1], corners[2]);
  const zm = corners[6];
  ctx.textAlign = "center";
  ctx.fillText(labels.x, xm.sx, xm.sy + 26);
  ctx.textAlign = "left";
  ctx.fillText(labels.y, ym.sx + 28, ym.sy);
  ctx.textAlign = "center";
  ctx.fillText(labels.z, zm.sx, zm.sy - 14);
}

function drawLegend(
  ctx: CanvasRenderingContext2D, w: number, h: number, theme: GraphTheme, zmin: number, zmax: number,
) {
  const barW = 12;
  const barX = w - barW - 14;
  const barTop = 28;
  const barBot = h - 28;
  const barH = barBot - barTop;
  if (barH < 20) return;
  const steps = 64;
  for (let i = 0; i < steps; i++) {
    const tt = 1 - i / (steps - 1);
    const [r, g, b] = colormapRGB(tt);
    ctx.fillStyle = `rgb(${Math.round(r)},${Math.round(g)},${Math.round(b)})`;
    ctx.fillRect(barX, barTop + (barH * i) / steps, barW, barH / steps + 1);
  }
  ctx.strokeStyle = theme.axisLine;
  ctx.lineWidth = 1;
  ctx.strokeRect(barX, barTop, barW, barH);
  ctx.fillStyle = theme.fgDim;
  ctx.font = "10px sans-serif";
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(fmtNum(zmax), barX - 4, barTop);
  ctx.fillText(fmtNum((zmin + zmax) / 2), barX - 4, (barTop + barBot) / 2);
  ctx.fillText(fmtNum(zmin), barX - 4, barBot);
}

export function Surface3D({ spec, data }: Surface3DProps) {
  const { t } = useTranslation();
  const themeMode = useThemeStore((s) => s.mode);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  const [yaw, setYaw] = useState(-0.7);
  const [pitch, setPitch] = useState(0.5);
  const [zoom, setZoom] = useState(1);
  const [dims, setDims] = useState({ w: 0, h: 0 });

  const xf = spec.encoding.x;
  const yf = spec.encoding.y;
  const zf = spec.encoding.z;

  const els = spec.elements ?? [];
  const surfaceEl = els.find((e) => e.kind === "surface" && e.enabled !== false);
  const pointsEl = els.find((e) => e.kind === "points" && e.enabled !== false);
  const stat: SurfaceStat = surfaceEl?.options?.stat === "median" ? "median" : "mean";

  // 曲面网格（需要 X/Y/Z 全绑定）。
  const surface = useMemo(
    () => (surfaceEl && xf && yf && zf ? buildSurfaceGrid(data, xf.name, yf.name, zf.name, GRID_N, stat) : null),
    [surfaceEl, xf, yf, zf, data, stat],
  );
  // 散点（需要 X/Y；Z 可选）。
  const pointData = useMemo(
    () => (pointsEl && xf && yf ? extractPoints(data, xf.name, yf.name, zf?.name) : null),
    [pointsEl, xf, yf, zf, data],
  );

  // 合并范围：优先用曲面范围，否则用散点范围。
  const ranges: Ranges | null = surface?.ranges ?? pointData?.ranges ?? null;

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setDims({ w: el.clientWidth, h: el.clientHeight }));
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !ranges || dims.w <= 0 || dims.h <= 0) return;
    drawScene(
      canvas,
      ranges,
      surface?.grid ?? null,
      pointData?.pts ?? null,
      yaw, pitch, zoom, dims.w, dims.h,
      getGraphTheme(),
      { x: xf?.name ?? "X", y: yf?.name ?? "Y", z: zf?.name ?? "Z" },
    );
  }, [ranges, surface, pointData, yaw, pitch, zoom, dims, themeMode, xf, yf, zf]);

  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, yaw, pitch };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    setYaw(d.yaw + (e.clientX - d.x) * 0.01);
    setPitch(Math.max(0.05, Math.min(Math.PI / 2 - 0.05, d.pitch + (e.clientY - d.y) * 0.01)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    setZoom((z) => Math.max(0.3, Math.min(4, z * Math.exp(-e.deltaY * 0.001))));
  };

  // 提示分支。
  if (!surfaceEl && !pointsEl) {
    return <div className="gb-empty">{t("graph.threeD.addSurface", { defaultValue: "Add a Surface or Scatter layer to render in 3D." })}</div>;
  }
  if (!xf || !yf) {
    return <div className="gb-empty">{t("graph.threeD.dragXY", { defaultValue: "Drag columns onto X and Y (and Z) to build a 3D chart." })}</div>;
  }
  if (surfaceEl && !zf) {
    return <div className="gb-empty">{t("graph.threeD.dragHint", { defaultValue: "Drag a column onto Z to build a 3D surface." })}</div>;
  }
  if (!ranges) {
    return <div className="gb-empty">{t("graph.threeD.notEnough", { defaultValue: "Need at least 3 rows with numeric values." })}</div>;
  }

  return (
    <div
      ref={containerRef}
      style={{ width: "100%", height: "100%", position: "relative", cursor: drag.current ? "grabbing" : "grab" }}
    >
      <canvas
        ref={canvasRef}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
        onWheel={onWheel}
        style={{ display: "block", touchAction: "none" }}
      />
    </div>
  );
}
