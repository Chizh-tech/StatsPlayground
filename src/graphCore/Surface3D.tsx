/**
 * Surface3D — 自包含（无第三方 3D 依赖）的三维曲面渲染器。
 *
 * 由 <Graph> 在 `spec.threeD === true` 且存在启用的 "surface" 图层时，
 * 替代 2D ECharts 面板渲染。从 encoding.x / y / z 三个数值通道取点，
 * 按网格分箱聚合（均值 / 中位数，由 surface 图层的 `stat` 选项决定），
 * 空网格用反距离加权（IDW）填补，再以正交投影 + 画家算法（按深度
 * 从远到近）绘制到 <canvas>：按高度着色（viridis 色阶）+ 法线明暗，
 * 带坐标轴刻度数值与竖向颜色图例。支持鼠标拖动旋转、滚轮缩放。
 *
 * 之所以不使用 echarts-gl：当前环境无法安装该依赖（TLS 握手失败），
 * 且本应用主打「超轻量」，自绘方案零依赖、可完全掌控。
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

/** 网格大小（N×N 顶点）。越大越平滑，但四边形数 ~ (N-1)² 会增加。 */
const GRID_N = 40;

interface SurfaceGrid {
  n: number;
  /** 行优先的 z 网格值，长度 n*n。 */
  zg: Float64Array;
  xmin: number; xmax: number;
  ymin: number; ymax: number;
  zmin: number; zmax: number;
}

/** 从散点 (x,y,z) 按网格分箱聚合（mean/median）构建曲面，空格用 IDW 填补。 */
function buildSurfaceGrid(
  data: GraphData,
  xName: string,
  yName: string,
  zName: string,
  n: number,
  stat: SurfaceStat,
): SurfaceGrid | null {
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
      if (x < xmin) xmin = x;
      if (x > xmax) xmax = x;
      if (y < ymin) ymin = y;
      if (y > ymax) ymax = y;
    }
  }
  const p = xs.length;
  if (p < 3) return null;
  const dx = xmax - xmin || 1;
  const dy = ymax - ymin || 1;

  // 分箱：把每个点归到最近的网格顶点。
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

  // IDW 填补空网格（power 4，仅用已占用网格作源）。
  for (let gj = 0; gj < n; gj++) {
    for (let gi = 0; gi < n; gi++) {
      const idx = gj * n + gi;
      if (filled[idx]) continue;
      let num = 0;
      let den = 0;
      let exact = NaN;
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
  return { n, zg, xmin, xmax, ymin, ymax, zmin, zmax };
}

/** viridis 风格色阶控制点。 */
const VIRIDIS: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];
function colormapRGB(t: number): [number, number, number] {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[Math.min(i + 1, VIRIDIS.length - 1)];
  return [
    a[0] + (b[0] - a[0]) * f,
    a[1] + (b[1] - a[1]) * f,
    a[2] + (b[2] - a[2]) * f,
  ];
}

/** 简洁数字格式。 */
function fmtNum(v: number): string {
  if (!Number.isFinite(v)) return "";
  if (Math.abs(v) >= 1e5 || (Math.abs(v) > 0 && Math.abs(v) < 1e-3)) {
    return v.toExponential(2);
  }
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

/** 绘制曲面到 canvas。 */
function drawSurface(
  canvas: HTMLCanvasElement,
  grid: SurfaceGrid,
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

  const { n, zg, zmin, zmax } = grid;
  const zrange = zmax - zmin || 1;
  // 给右侧图例留出空间。
  const cx = w / 2 - 24;
  const cy = h / 2;
  const scale = Math.min(w - 70, h) * 0.6 * zoom;
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch);

  // 归一化坐标 [-0.5,0.5] → 旋转 → 正交投影。depth = 旋转后的 y（越大越远）。
  const project = (nx: number, ny: number, nz: number): Projected => {
    const x1 = nx * cosY - ny * sinY;
    const y1 = nx * sinY + ny * cosY;
    const y2 = y1 * cosP - nz * sinP;
    const z2 = y1 * sinP + nz * cosP;
    return { sx: cx + x1 * scale, sy: cy - z2 * scale, depth: y2 };
  };

  // 预计算网格顶点的 3D 归一化坐标与投影。
  const pos3: Vec3[] = new Array(n * n);
  const proj: Projected[] = new Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const nx = i / (n - 1) - 0.5;
      const ny = j / (n - 1) - 0.5;
      const nz = (zg[j * n + i] - zmin) / zrange - 0.5;
      pos3[j * n + i] = { x: nx, y: ny, z: nz };
      proj[j * n + i] = project(nx, ny, nz);
    }
  }

  // 后置包围盒边（先画，位于曲面之下）。
  drawFrame(ctx, project, theme, labels, grid, true);

  // 光照方向（世界空间，固定）。
  const L = normalize({ x: -0.5, y: -0.6, z: 0.75 });

  interface Quad { a: Projected; b: Projected; c: Projected; d: Projected; depth: number; z: number; shade: number }
  const quads: Quad[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const ia = j * n + i;
      const ib = j * n + i + 1;
      const ic = (j + 1) * n + i + 1;
      const id = (j + 1) * n + i;
      const a = proj[ia], b = proj[ib], c = proj[ic], d = proj[id];
      const depth = (a.depth + b.depth + c.depth + d.depth) / 4;
      const zavg = (zg[ia] + zg[ib] + zg[ic] + zg[id]) / 4;
      // 面法线（对角叉积），用于明暗。
      const nrm = normalize(cross(sub(pos3[ic], pos3[ia]), sub(pos3[id], pos3[ib])));
      const ndl = Math.abs(nrm.x * L.x + nrm.y * L.y + nrm.z * L.z);
      const shade = 0.55 + 0.55 * ndl; // [0.55, 1.1]
      quads.push({ a, b, c, d, depth, z: zavg, shade });
    }
  }
  quads.sort((p, q) => q.depth - p.depth);

  for (const qd of quads) {
    const [r, g, bl] = colormapRGB((qd.z - zmin) / zrange);
    const s = qd.shade;
    const cr = Math.max(0, Math.min(255, Math.round(r * s)));
    const cg = Math.max(0, Math.min(255, Math.round(g * s)));
    const cb = Math.max(0, Math.min(255, Math.round(bl * s)));
    ctx.beginPath();
    ctx.moveTo(qd.a.sx, qd.a.sy);
    ctx.lineTo(qd.b.sx, qd.b.sy);
    ctx.lineTo(qd.c.sx, qd.c.sy);
    ctx.lineTo(qd.d.sx, qd.d.sy);
    ctx.closePath();
    ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.08)";
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // 前置包围盒边 + 轴标题 + 刻度（画在曲面之上）。
  drawFrame(ctx, project, theme, labels, grid, false);

  // 竖向颜色图例。
  drawLegend(ctx, w, h, theme, zmin, zmax);
}

/** 画包围立方体的边、轴标题与刻度数值。`back` 为 true 时只画偏后的边，
 *  false 时画其余边并放置轴标题 + 刻度。 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  project: (nx: number, ny: number, nz: number) => Projected,
  theme: GraphTheme,
  labels: { x: string; y: string; z: string },
  grid: SurfaceGrid,
  back: boolean,
) {
  const cube: [number, number, number][] = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  ];
  const corners = cube.map((c) => project(c[0], c[1], c[2]));
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0],
    [4, 5], [5, 6], [6, 7], [7, 4],
    [0, 4], [1, 5], [2, 6], [3, 7],
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

  // 刻度：沿三条代表边（X: 0→1, Y: 1→2, Z: 2→6）各放 min/mid/max。
  ctx.fillStyle = theme.fgDim;
  ctx.font = "10px sans-serif";
  const tick = (
    from: Projected,
    to: Projected,
    v0: number,
    v1: number,
    align: CanvasTextAlign,
    ox: number,
    oy: number,
  ) => {
    ctx.textAlign = align;
    ctx.textBaseline = "middle";
    for (const f of [0, 0.5, 1]) {
      const sx = from.sx + (to.sx - from.sx) * f + ox;
      const sy = from.sy + (to.sy - from.sy) * f + oy;
      ctx.fillText(fmtNum(v0 + (v1 - v0) * f), sx, sy);
    }
  };
  tick(corners[0], corners[1], grid.xmin, grid.xmax, "center", 0, 12);
  tick(corners[1], corners[2], grid.ymin, grid.ymax, "left", 8, 0);
  tick(corners[2], corners[6], grid.zmin, grid.zmax, "right", -8, 0);

  // 轴标题。
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

/** 右侧竖向颜色图例（低→高对应 zmin→zmax）。 */
function drawLegend(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  theme: GraphTheme,
  zmin: number,
  zmax: number,
) {
  const barW = 12;
  const barX = w - barW - 14;
  const barTop = 28;
  const barBot = h - 28;
  const barH = barBot - barTop;
  if (barH < 20) return;
  const steps = 64;
  for (let i = 0; i < steps; i++) {
    const tt = 1 - i / (steps - 1); // 顶部 t=1（zmax）
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
  const ready = !!(xf && yf && zf);

  // 找到启用的 surface 图层及其统计量。
  const surfaceEl = spec.elements?.find((e) => e.kind === "surface" && e.enabled !== false);
  const stat: SurfaceStat = surfaceEl?.options?.stat === "median" ? "median" : "mean";
  const hasSurface = !!surfaceEl;

  const grid = useMemo(
    () => (ready && hasSurface ? buildSurfaceGrid(data, xf!.name, yf!.name, zf!.name, GRID_N, stat) : null),
    [ready, hasSurface, data, xf, yf, zf, stat],
  );

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setDims({ w: el.clientWidth, h: el.clientHeight });
    });
    ro.observe(el);
    setDims({ w: el.clientWidth, h: el.clientHeight });
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid || dims.w <= 0 || dims.h <= 0) return;
    drawSurface(canvas, grid, yaw, pitch, zoom, dims.w, dims.h, getGraphTheme(), {
      x: xf!.name,
      y: yf!.name,
      z: zf!.name,
    });
  }, [grid, yaw, pitch, zoom, dims, themeMode, xf, yf, zf]);

  const drag = useRef<{ x: number; y: number; yaw: number; pitch: number } | null>(null);
  const onPointerDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    drag.current = { x: e.clientX, y: e.clientY, yaw, pitch };
    (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    setYaw(d.yaw + dx * 0.01);
    const nextPitch = d.pitch + dy * 0.01;
    setPitch(Math.max(0.05, Math.min(Math.PI / 2 - 0.05, nextPitch)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    setZoom((z) => Math.max(0.3, Math.min(4, z * Math.exp(-e.deltaY * 0.001))));
  };

  if (!hasSurface) {
    return (
      <div className="gb-empty">
        {t("graph.threeD.addSurface", {
          defaultValue: "Add a Surface layer to render a 3D surface.",
        })}
      </div>
    );
  }
  if (!ready) {
    return (
      <div className="gb-empty">
        {t("graph.threeD.dragHint", {
          defaultValue: "Drag columns onto X, Y and Z to build a 3D surface.",
        })}
      </div>
    );
  }
  if (!grid) {
    return (
      <div className="gb-empty">
        {t("graph.threeD.notEnough", {
          defaultValue: "Need at least 3 rows with numeric X / Y / Z values.",
        })}
      </div>
    );
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
