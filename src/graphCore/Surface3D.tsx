/**
 * Surface3D — 自包含（无第三方 3D 依赖）的三维曲面渲染器。
 *
 * 由 <Graph> 在 `spec.threeD === true` 时替代 2D ECharts 面板渲染。
 * 从 encoding.x / y / z 三个数值通道取点，用反距离加权（IDW）插值
 * 到规则网格，再以正交投影 + 画家算法（按深度从远到近）绘制到
 * <canvas>，按高度着色（viridis 色阶）。支持鼠标拖动旋转、滚轮缩放。
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

/** 网格大小（N×N 顶点）。越大越平滑，但四边形数 ~ (N-1)² 会增加。 */
const GRID_N = 36;
/** 参与插值的最大点数（防止大数据集卡顿）。 */
const SAMPLE_CAP = 4000;

interface SurfaceGrid {
  n: number;
  /** 行优先的 z 网格值，长度 n*n。 */
  zg: Float64Array;
  xmin: number; xmax: number;
  ymin: number; ymax: number;
  zmin: number; zmax: number;
}

/** 从散点 (x,y,z) 用 IDW 插值构建规则网格。 */
function buildSurfaceGrid(
  data: GraphData,
  xName: string,
  yName: string,
  zName: string,
  n: number,
): SurfaceGrid | null {
  const xi = data.columns.indexOf(xName);
  const yi = data.columns.indexOf(yName);
  const zi = data.columns.indexOf(zName);
  if (xi < 0 || yi < 0 || zi < 0) return null;

  const xs: number[] = [];
  const ys: number[] = [];
  const zs: number[] = [];
  for (const row of data.rows) {
    const x = Number(row[xi]);
    const y = Number(row[yi]);
    const z = Number(row[zi]);
    if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z)) {
      xs.push(x); ys.push(y); zs.push(z);
    }
  }
  const p = xs.length;
  if (p < 3) return null;

  // 下采样以控制 IDW 成本（O(gridCells * points)）。
  let idx: number[];
  if (p > SAMPLE_CAP) {
    idx = [];
    const step = p / SAMPLE_CAP;
    for (let i = 0; i < SAMPLE_CAP; i++) idx.push(Math.floor(i * step));
  } else {
    idx = Array.from({ length: p }, (_, i) => i);
  }

  let xmin = Infinity, xmax = -Infinity, ymin = Infinity, ymax = -Infinity;
  for (const i of idx) {
    if (xs[i] < xmin) xmin = xs[i];
    if (xs[i] > xmax) xmax = xs[i];
    if (ys[i] < ymin) ymin = ys[i];
    if (ys[i] > ymax) ymax = ys[i];
  }
  const dx = xmax - xmin || 1;
  const dy = ymax - ymin || 1;

  const zg = new Float64Array(n * n);
  let zmin = Infinity, zmax = -Infinity;
  for (let gy = 0; gy < n; gy++) {
    const py = ymin + (dy * gy) / (n - 1);
    for (let gx = 0; gx < n; gx++) {
      const px = xmin + (dx * gx) / (n - 1);
      let num = 0;
      let den = 0;
      let exact = NaN;
      for (const i of idx) {
        const ndx = (xs[i] - px) / dx;
        const ndy = (ys[i] - py) / dy;
        const d2 = ndx * ndx + ndy * ndy;
        if (d2 < 1e-9) { exact = zs[i]; break; }
        // IDW power 4 (1/d^4) — localizes influence so nearby points
        // dominate, giving a crisper surface than plain 1/d^2.
        const w = 1 / (d2 * d2);
        num += w * zs[i];
        den += w;
      }
      const v = Number.isFinite(exact) ? exact : den > 0 ? num / den : 0;
      zg[gy * n + gx] = v;
      if (v < zmin) zmin = v;
      if (v > zmax) zmax = v;
    }
  }
  return { n, zg, xmin, xmax, ymin, ymax, zmin, zmax };
}

/** viridis 风格色阶：t ∈ [0,1] → CSS 颜色。 */
const VIRIDIS: [number, number, number][] = [
  [68, 1, 84],
  [59, 82, 139],
  [33, 145, 140],
  [94, 201, 98],
  [253, 231, 37],
];
function colormap(t: number): string {
  const x = Math.max(0, Math.min(1, t)) * (VIRIDIS.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = VIRIDIS[i];
  const b = VIRIDIS[Math.min(i + 1, VIRIDIS.length - 1)];
  const r = Math.round(a[0] + (b[0] - a[0]) * f);
  const g = Math.round(a[1] + (b[1] - a[1]) * f);
  const bl = Math.round(a[2] + (b[2] - a[2]) * f);
  return `rgb(${r},${g},${bl})`;
}

interface Projected { sx: number; sy: number; depth: number }

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
  const cx = w / 2;
  const cy = h / 2;
  const scale = Math.min(w, h) * 0.62 * zoom;
  const cosY = Math.cos(yaw), sinY = Math.sin(yaw);
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch);

  // 归一化坐标 [-0.5,0.5] → 旋转 → 正交投影。
  // depth = 旋转后的 y（越大越远）。
  const project = (nx: number, ny: number, nz: number): Projected => {
    const x1 = nx * cosY - ny * sinY;
    const y1 = nx * sinY + ny * cosY;
    const y2 = y1 * cosP - nz * sinP;
    const z2 = y1 * sinP + nz * cosP;
    return { sx: cx + x1 * scale, sy: cy - z2 * scale, depth: y2 };
  };

  // 预计算网格顶点投影。
  const proj: Projected[] = new Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const nx = i / (n - 1) - 0.5;
      const ny = j / (n - 1) - 0.5;
      const nz = (zg[j * n + i] - zmin) / zrange - 0.5;
      proj[j * n + i] = project(nx, ny, nz);
    }
  }

  // 先画底部包围盒背面边（网格地板 + 后墙），置于曲面之下。
  drawFrame(ctx, project, theme, labels, true);

  // 组装四边形并按深度排序（远 → 近）。
  interface Quad { a: Projected; b: Projected; c: Projected; d: Projected; depth: number; z: number }
  const quads: Quad[] = [];
  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const a = proj[j * n + i];
      const b = proj[j * n + i + 1];
      const c = proj[(j + 1) * n + i + 1];
      const d = proj[(j + 1) * n + i];
      const depth = (a.depth + b.depth + c.depth + d.depth) / 4;
      const zavg =
        (zg[j * n + i] + zg[j * n + i + 1] + zg[(j + 1) * n + i + 1] + zg[(j + 1) * n + i]) / 4;
      quads.push({ a, b, c, d, depth, z: zavg });
    }
  }
  quads.sort((p, q) => q.depth - p.depth);

  for (const qd of quads) {
    const fill = colormap((qd.z - zmin) / zrange);
    ctx.beginPath();
    ctx.moveTo(qd.a.sx, qd.a.sy);
    ctx.lineTo(qd.b.sx, qd.b.sy);
    ctx.lineTo(qd.c.sx, qd.c.sy);
    ctx.lineTo(qd.d.sx, qd.d.sy);
    ctx.closePath();
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = "rgba(0,0,0,0.10)";
    ctx.lineWidth = 0.5;
    ctx.stroke();
  }

  // 前面包围盒边 + 轴标题（画在曲面之上）。
  drawFrame(ctx, project, theme, labels, false);
}

/** 画包围立方体的边与轴标题。`back` 为 true 时只画偏后的三条底/后边，
 *  false 时画其余边并放置轴标题。用简单的深度阈值区分前后。 */
function drawFrame(
  ctx: CanvasRenderingContext2D,
  project: (nx: number, ny: number, nz: number) => Projected,
  theme: GraphTheme,
  labels: { x: string; y: string; z: string },
  back: boolean,
) {
  const corners: Projected[] = [];
  // 8 个立方体角，顺序：0..3 底 (z=-0.5)，4..7 顶 (z=0.5)
  const cube: [number, number, number][] = [
    [-0.5, -0.5, -0.5], [0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5],
    [-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5],
  ];
  for (const c of cube) corners.push(project(c[0], c[1], c[2]));
  const edges: [number, number][] = [
    [0, 1], [1, 2], [2, 3], [3, 0], // 底
    [4, 5], [5, 6], [6, 7], [7, 4], // 顶
    [0, 4], [1, 5], [2, 6], [3, 7], // 立柱
  ];
  const maxDepth = Math.max(...corners.map((c) => c.depth));
  const minDepth = Math.min(...corners.map((c) => c.depth));
  const mid = (maxDepth + minDepth) / 2;

  ctx.strokeStyle = theme.axisLine;
  ctx.lineWidth = 1;
  ctx.globalAlpha = back ? 0.5 : 0.85;
  for (const [a, b] of edges) {
    const ea = corners[a], eb = corners[b];
    const edgeDepth = (ea.depth + eb.depth) / 2;
    const isBack = edgeDepth > mid;
    if (isBack !== back) continue;
    ctx.beginPath();
    ctx.moveTo(ea.sx, ea.sy);
    ctx.lineTo(eb.sx, eb.sy);
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  if (!back) {
    // 轴标题：X 在底前边中点，Y 在底右边中点，Z 在一条立柱顶端。
    ctx.fillStyle = theme.fgSecondary;
    ctx.font = "12px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const midpt = (a: Projected, b: Projected) => ({ sx: (a.sx + b.sx) / 2, sy: (a.sy + b.sy) / 2 });
    const xm = midpt(corners[0], corners[1]);
    const ym = midpt(corners[1], corners[2]);
    const zm = corners[6];
    ctx.fillText(labels.x, xm.sx, xm.sy + 14);
    ctx.fillText(labels.y, ym.sx + 12, ym.sy);
    ctx.fillText(labels.z, zm.sx, zm.sy - 12);
  }
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

  const grid = useMemo(
    () => (ready ? buildSurfaceGrid(data, xf!.name, yf!.name, zf!.name, GRID_N) : null),
    [ready, data, xf, yf, zf],
  );

  // 尺寸跟随容器。
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

  // 重绘。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !grid || dims.w <= 0 || dims.h <= 0) return;
    drawSurface(canvas, grid, yaw, pitch, zoom, dims.w, dims.h, getGraphTheme(), {
      x: xf!.name,
      y: yf!.name,
      z: zf!.name,
    });
    // themeMode 变化会改变 getGraphTheme() 读到的 CSS 变量。
  }, [grid, yaw, pitch, zoom, dims, themeMode, xf, yf, zf]);

  // 拖动旋转。
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
    // 限制俯仰角，避免翻面 / 退化为一条线。
    const nextPitch = d.pitch + dy * 0.01;
    setPitch(Math.max(0.05, Math.min(Math.PI / 2 - 0.05, nextPitch)));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    drag.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  };
  const onWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    setZoom((z) => Math.max(0.3, Math.min(4, z * Math.exp(-e.deltaY * 0.001))));
  };

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
