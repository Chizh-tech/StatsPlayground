/**
 * <Graph> 组件 — Graph Core 的 React 入口
 *
 * 接收 GraphSpec + GraphData，渲染为一个或多个 ECharts 实例（分面）。
 * 自动响应窗口尺寸变化与主题变化。
 */

import { useEffect, useMemo, useRef } from "react";
import * as echarts from "echarts";
import type { GraphSpec, GraphData } from "./types";
import { getGraphTheme } from "./theme";
import { buildGraph } from "./transform";
import { useThemeStore } from "@/stores/useThemeStore";

interface GraphProps {
  spec: GraphSpec;
  data: GraphData;
  className?: string;
  /** 单个面板最小宽 */
  minPanelWidth?: number;
  /** 单个面板最小高 */
  minPanelHeight?: number;
  /**
   * Optional per-column user-defined value ordering. Keyed by column name;
   * each entry lists the categorical values in the order they should appear
   * on category axes (X / boxplot bins), in the legend, and in faceted
   * panels. Values missing from a list keep their natural data order at
   * the end (see transform.ts `applyValueOrder`).
   */
  valueOrders?: Record<string, string[]>;
  /**
   * Fired when the user double-clicks anywhere inside the Y axis region
   * (axis line, ticks, labels, or the title strip). The GraphBuilder
   * opens its Y Axis settings dialog from here so users have a discoverable,
   * direct-manipulation entry point next to the axis itself.
   */
  onYAxisDblClick?: () => void;
  /**
   * Fired when the user double-clicks anywhere inside the X axis region
   * (axis line, ticks, labels, or the title strip at the bottom of the
   * chart). Mirrors `onYAxisDblClick` — the GraphBuilder opens its
   * X Axis settings dialog from here.
   */
  onXAxisDblClick?: () => void;
  /**
   * Fired when the user finishes a drag gesture on either axis to pin
   * a new `[min, max]` range. Two gestures produce this callback:
   *   • click-and-drag the OUTER thirds of the axis strip ("min" or
   *     "max" handle) — stretches/shrinks that end of the range,
   *   • click-and-drag the MIDDLE third ("pan") — shifts both bounds
   *     by the same amount so the visible window scrolls.
   * The visual preview during the drag is applied directly via
   * `setOption` for snappy feedback; on mouseup we read the final
   * bounds back from the chart and commit them through this callback
   * so they persist to project state (and ride through future
   * re-renders). Skipped on category axes since min/max are
   * meaningless there.
   */
  onAxisRangeChange?: (axis: "x" | "y", min: number, max: number) => void;
}

export function Graph({ spec, data, className, minPanelWidth = 320, minPanelHeight = 240, valueOrders, onYAxisDblClick, onXAxisDblClick, onAxisRangeChange }: GraphProps) {
  // 订阅主题变化以触发重渲染
  const themeMode = useThemeStore((s) => s.mode);

  const built = useMemo(() => {
    const theme = getGraphTheme();
    return buildGraph(spec, data, theme, valueOrders);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, data, themeMode, valueOrders]);

  return (
    <div
      className={`gc-graph${className ? " " + className : ""}`}
      style={{
        display: "grid",
        gridTemplateColumns: `repeat(${built.cols}, minmax(${minPanelWidth}px, 1fr))`,
        // Explicit row count is required so Group Y (vertical faceting)
        // actually stacks panels into N rows — without this, the grid
        // falls back to a single implicit row and panels reflow into the
        // X axis only. minmax() keeps each row from collapsing below the
        // per-panel minimum height while still letting the grid grow to
        // fill the available space.
        gridTemplateRows: `repeat(${built.rows}, minmax(${minPanelHeight}px, 1fr))`,
        gap: 8,
        width: "100%",
        height: "100%",
        overflow: "auto",
        padding: 4,
      }}
    >
      {built.panels.map((p, i) => (
        <GraphPanel
          key={i}
          title={p.title}
          option={p.option}
          minHeight={minPanelHeight}
          onYAxisDblClick={onYAxisDblClick}
          onXAxisDblClick={onXAxisDblClick}
          onAxisRangeChange={onAxisRangeChange}
        />
      ))}
    </div>
  );
}

interface GraphPanelProps {
  title: string;
  option: Record<string, unknown>;
  minHeight: number;
  onYAxisDblClick?: () => void;
  onXAxisDblClick?: () => void;
  onAxisRangeChange?: (axis: "x" | "y", min: number, max: number) => void;
}

function GraphPanel({ title, option, minHeight, onYAxisDblClick, onXAxisDblClick, onAxisRangeChange }: GraphPanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  // Keep the latest callbacks in refs so the Zrender dblclick handler
  // (which we register exactly once on mount) always sees the freshest
  // closure without forcing a re-bind on every prop change.
  const onYAxisDblClickRef = useRef(onYAxisDblClick);
  const onXAxisDblClickRef = useRef(onXAxisDblClick);
  const onAxisRangeChangeRef = useRef(onAxisRangeChange);
  useEffect(() => {
    onYAxisDblClickRef.current = onYAxisDblClick;
  }, [onYAxisDblClick]);
  useEffect(() => {
    onXAxisDblClickRef.current = onXAxisDblClick;
  }, [onXAxisDblClick]);
  useEffect(() => {
    onAxisRangeChangeRef.current = onAxisRangeChange;
  }, [onAxisRangeChange]);

  // 初始化 / 销毁
  useEffect(() => {
    if (!ref.current) return;
    const inst = echarts.init(ref.current, undefined, { renderer: "canvas" });
    chartRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(ref.current);

    // ----- Y / X axis double-click -----------------------------------
    // ECharts' component-targeted `inst.on('dblclick', { componentType:
    // 'yAxis' }, ...)` only fires when the user dblclicks an axis label
    // or the axis line itself — empty space inside the axis strip (tick
    // gaps, the title area) is missed. To make the gesture forgiving we
    // also listen at the Zrender level: a dblclick that lands inside the
    // Y-axis band (either reported by `containPixel({ yAxisIndex: 0 })`
    // or anywhere in the left margin to the left of the grid) opens the
    // Y settings dialog. The X axis uses the symmetrical bottom-margin
    // fallback. When a click sits in the bottom-left corner of the chart
    // (overlap between the two strips) we resolve it via `containPixel`
    // first; only fall back to the geometric strip if both axis hit
    // tests fail — then prefer Y (the historical default).
    const zr = inst.getZr();
    const zrHandler = (e: { offsetX: number; offsetY: number }) => {
      const yCb = onYAxisDblClickRef.current;
      const xCb = onXAxisDblClickRef.current;
      if (!yCb && !xCb) return;
      const pt: [number, number] = [e.offsetX, e.offsetY];
      let inYAxis = false;
      let inXAxis = false;
      try {
        inYAxis = inst.containPixel({ yAxisIndex: 0 }, pt);
      } catch {
        // containPixel can throw if the chart hasn't laid out yet —
        // ignore and fall through to the geometry-based fallback.
      }
      try {
        inXAxis = inst.containPixel({ xAxisIndex: 0 }, pt);
      } catch {
        // see above
      }
      const el = ref.current;
      if (!inYAxis && !inXAxis && el) {
        // Geometric fallback: treat the left margin as Y and the bottom
        // margin as X. Conservative caps (80px / 18%) keep the central
        // chart body from triggering either dialog.
        const w = el.clientWidth;
        const h = el.clientHeight;
        const inLeftMargin =
          e.offsetX >= 0 &&
          e.offsetX <= Math.min(80, w * 0.18) &&
          e.offsetY >= 0 &&
          e.offsetY <= h;
        const inBottomMargin =
          e.offsetY <= h &&
          e.offsetY >= h - Math.min(60, h * 0.18) &&
          e.offsetX >= 0 &&
          e.offsetX <= w;
        // Prefer Y when both strips overlap (bottom-left corner) so
        // the existing behavior near the Y title block stays unchanged.
        if (inLeftMargin) inYAxis = true;
        else if (inBottomMargin) inXAxis = true;
      }
      // ECharts' axis hit regions can overlap inside the plot area for
      // some chart types; if both report true, prefer the X axis here
      // (the user clicked near the X tick row) only when Y wouldn't
      // open a dialog — otherwise default to Y.
      if (inYAxis && yCb) yCb();
      else if (inXAxis && xCb) xCb();
    };
    zr.on("dblclick", zrHandler);

    // ----- Drag-zoom / drag-pan via native pointer events ------------
    // Mental model the user asked for: the canvas is a *viewport* onto
    // an infinite graph. Grabbing the EDGE of the canvas (the axis
    // strip) lets you stretch / shrink the visible range — the data
    // point under your cursor follows your cursor outward. Grabbing
    // the MIDDLE of the canvas (the chart body) pans both axes — the
    // data slides under your cursor in the direction you drag. Within
    // an axis strip the outer thirds are single-end zoom (one bound
    // moves, the other is anchored) and the middle third pans that
    // axis only.
    //
    // We use NATIVE PointerEvents on the container with
    // `setPointerCapture` so the gesture survives the cursor leaving
    // the chart and so `pointerup` always fires (the previous
    // implementation used ZRender mousedown + window mouseup and would
    // occasionally drop the release — "鼠标点击后无法释放"). Capture is
    // only taken AFTER a 3-pixel movement threshold, so a click that
    // doesn't move (the first half of a double-click, a series click,
    // an ECharts tooltip hover) still propagates to ZRender normally.
    //
    // Sign convention follows the cursor: dragging an axis end OUTWARD
    // (away from the chart center) is "拉大" → the visible range
    // SHRINKS so each remaining unit takes more screen space (zoom in).
    // Dragging the chart middle drags the data — the value under your
    // cursor stays approximately under your cursor throughout.
    //
    // The pixel-to-data sensitivity uses the GRID rect's width / height,
    // so a one-pixel drag changes the bound(s) by exactly one pixel's
    // worth of data — the linearization of true "cursor-follow" math
    // (which would explode near the anchored edge). Skipped on category
    // axes (numeric min/max meaningless) and on inverted axes (sign
    // flip not handled).
    const el = ref.current;
    type GridLike = { x: number; y: number; width: number; height: number } | undefined;
    const getGridRect = (): GridLike => {
      try {
        const m = (inst as unknown as { getModel: () => { getComponent: (type: string, idx: number) => unknown } }).getModel?.();
        const grid = m?.getComponent?.("grid", 0) as
          | { coordinateSystem?: { getRect?: () => { x: number; y: number; width: number; height: number } } }
          | undefined;
        return grid?.coordinateSystem?.getRect?.();
      } catch {
        return undefined;
      }
    };
    const getAxisType = (which: "x" | "y"): string | undefined => {
      try {
        const m = (inst as unknown as { getModel: () => { getComponent: (type: string, idx: number) => unknown } }).getModel?.();
        const ax = m?.getComponent?.(which === "y" ? "yAxis" : "xAxis", 0) as
          | { get?: (key: string) => unknown }
          | undefined;
        return ax?.get?.("type") as string | undefined;
      } catch {
        return undefined;
      }
    };
    const isAxisInverse = (which: "x" | "y"): boolean => {
      try {
        const m = (inst as unknown as { getModel: () => { getComponent: (type: string, idx: number) => unknown } }).getModel?.();
        const ax = m?.getComponent?.(which === "y" ? "yAxis" : "xAxis", 0) as
          | { get?: (key: string) => unknown }
          | undefined;
        return !!ax?.get?.("inverse");
      } catch {
        return false;
      }
    };
    // Read current numeric bounds for one axis by sampling the data
    // values at the two grid corners — works whether the user has
    // pinned a manual min/max or is on auto-fit.
    const readAxisBounds = (which: "x" | "y"): { min: number; max: number } | null => {
      if (getAxisType(which) === "category") return null;
      if (isAxisInverse(which)) return null;
      const r = getGridRect();
      if (!r) return null;
      try {
        const finder = which === "y" ? { yAxisIndex: 0 } : { xAxisIndex: 0 };
        const aPx = which === "y" ? r.y : r.x;
        const bPx = which === "y" ? r.y + r.height : r.x + r.width;
        const a = Number(inst.convertFromPixel(finder, aPx));
        const b = Number(inst.convertFromPixel(finder, bPx));
        // y: top pixel = max, bottom pixel = min. x: left = min, right = max.
        const mx = which === "y" ? a : b;
        const mn = which === "y" ? b : a;
        if (!Number.isFinite(mn) || !Number.isFinite(mx) || mx <= mn) return null;
        return { min: mn, max: mx };
      } catch {
        return null;
      }
    };

    // Inline {1, 2, 2.5, 5, 10}×10^k tick-step picker — duplicated
    // from transform.ts's `niceStep` so the in-drag preview can
    // recompute a fresh interval for every (min, max) frame. Without
    // this, ECharts keeps whatever interval the option last had, and
    // dragging the range BIGGER leaves too small a step (30+ tick
    // labels cramming the axis) while dragging it SMALLER leaves too
    // large a step. That's the asymmetric "刻度尺会发生变化" the user
    // observed between drag-down (shrinks the range) and drag-up
    // (grows it).
    const niceInterval = (range: number, targetTicks = 8): number => {
      if (!Number.isFinite(range) || range <= 0) return 1;
      const rough = range / targetTicks;
      const exp = Math.pow(10, Math.floor(Math.log10(rough)));
      const norm = rough / exp;
      let nice: number;
      if (norm < 1.5) nice = 1;
      else if (norm < 2.25) nice = 2;
      else if (norm < 3.5) nice = 2.5;
      else if (norm < 7.5) nice = 5;
      else nice = 10;
      return nice * exp;
    };

    type DragMode =
      | "y-min" | "y-max" | "y-pan"
      | "x-min" | "x-max" | "x-pan"
      | "xy-pan";
    type Grip = {
      mode: DragMode;
      startXMin?: number; startXMax?: number; xPxRange?: number;
      startYMin?: number; startYMax?: number; yPxRange?: number;
    };
    /** Classify a panel-local pixel into a drag mode. */
    const getAxisGrip = (px: number, py: number): Grip | null => {
      const r = getGridRect();
      if (!r) return null;
      const panelH = el?.clientHeight ?? 0;
      const panelW = el?.clientWidth ?? 0;
      const inYStrip = px >= 0 && px < r.x && py >= r.y && py <= r.y + r.height;
      const inXStrip = py > r.y + r.height && py <= panelH && px >= r.x && px <= r.x + r.width;
      const inBody = px >= r.x && px <= r.x + r.width && py >= r.y && py <= r.y + r.height && px <= panelW;
      if (inYStrip) {
        const yb = readAxisBounds("y");
        if (!yb) return null;
        const t = (py - r.y) / r.height;
        // y screen: top (t≈0) = max end, bottom (t≈1) = min end
        const mode: DragMode = t < 0.25 ? "y-max" : t > 0.75 ? "y-min" : "y-pan";
        return { mode, startYMin: yb.min, startYMax: yb.max, yPxRange: r.height };
      }
      if (inXStrip) {
        const xb = readAxisBounds("x");
        if (!xb) return null;
        const t = (px - r.x) / r.width;
        const mode: DragMode = t < 0.25 ? "x-min" : t > 0.75 ? "x-max" : "x-pan";
        return { mode, startXMin: xb.min, startXMax: xb.max, xPxRange: r.width };
      }
      if (inBody) {
        const xb = readAxisBounds("x");
        const yb = readAxisBounds("y");
        if (!xb || !yb) return null;
        return {
          mode: "xy-pan",
          startXMin: xb.min, startXMax: xb.max, xPxRange: r.width,
          startYMin: yb.min, startYMax: yb.max, yPxRange: r.height,
        };
      }
      return null;
    };

    const DRAG_THRESHOLD_PX = 3;
    type DragState = Grip & {
      startPx: number; startPy: number;
      pointerId: number;
      moved: boolean;
      captured: boolean;
      lastXMin?: number; lastXMax?: number;
      lastYMin?: number; lastYMax?: number;
    };
    let dragState: DragState | null = null;

    const cursorForMode = (mode: DragMode, active: boolean): string => {
      switch (mode) {
        case "y-min":
        case "y-max":
          return "row-resize";
        case "x-min":
        case "x-max":
          return "col-resize";
        case "y-pan":
        case "x-pan":
        case "xy-pan":
          return active ? "grabbing" : "grab";
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      if (!onAxisRangeChangeRef.current) return;
      const rect = el.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const py = e.clientY - rect.top;
      const grip = getAxisGrip(px, py);
      if (!grip) return;
      dragState = {
        ...grip,
        startPx: px,
        startPy: py,
        pointerId: e.pointerId,
        moved: false,
        captured: false,
        lastXMin: grip.startXMin,
        lastXMax: grip.startXMax,
        lastYMin: grip.startYMin,
        lastYMax: grip.startYMax,
      };
      // Don't preventDefault or capture yet — wait until threshold is
      // crossed so a stationary click still flows through to ECharts
      // (tooltip dwell, series click, dblclick-to-open-dialog).
    };

    const onPointerMove = (e: PointerEvent) => {
      // Hover cursor when not dragging — gives the user a hint about
      // what mode the next mousedown will start.
      if (!dragState) {
        const rect = el.getBoundingClientRect();
        const px = e.clientX - rect.left;
        const py = e.clientY - rect.top;
        const g = getAxisGrip(px, py);
        el.style.cursor = g ? cursorForMode(g.mode, false) : "";
        return;
      }
      const st = dragState;
      if (e.pointerId !== st.pointerId) return;
      const rect = el.getBoundingClientRect();
      const curPx = e.clientX - rect.left;
      const curPy = e.clientY - rect.top;
      const dx = curPx - st.startPx;
      const dy = curPy - st.startPy;
      if (!st.moved && Math.hypot(dx, dy) >= DRAG_THRESHOLD_PX) {
        st.moved = true;
        el.style.cursor = cursorForMode(st.mode, true);
        // Once we know it's a drag (not a click), claim the pointer so
        // pointerup fires on us even if the cursor leaves the panel.
        try { el.setPointerCapture(st.pointerId); st.captured = true; } catch { /* ignore */ }
        e.preventDefault();
      }
      if (!st.moved) return;
      // Sign convention: cursor-follow. Dragging right pulls the X
      // values left under the cursor (so xmin/xmax DECREASE on right
      // drag). Dragging down pulls the Y values up (so ymin/ymax
      // INCREASE on down drag because data-y increases upward).
      // For single-end handles, only the named bound moves; the
      // OPPOSITE end stays anchored. This is what makes outward drag
      // feel like "拉大 / stretch the graph outward" → fewer units
      // visible → zoom in.
      const patch: { xAxis?: Record<string, unknown>; yAxis?: Record<string, unknown> } = {};
      const isYMode = st.mode === "y-min" || st.mode === "y-max" || st.mode === "y-pan" || st.mode === "xy-pan";
      const isXMode = st.mode === "x-min" || st.mode === "x-max" || st.mode === "x-pan" || st.mode === "xy-pan";
      if (isYMode && st.startYMin !== undefined && st.startYMax !== undefined && st.yPxRange) {
        const ySpan = st.startYMax - st.startYMin;
        const ySf = ySpan / st.yPxRange;
        const yDelta = dy * ySf; // drag DOWN → both bounds increase
        let newYMin = st.startYMin;
        let newYMax = st.startYMax;
        if (st.mode === "y-min") newYMin = st.startYMin + yDelta;
        else if (st.mode === "y-max") newYMax = st.startYMax + yDelta;
        else { newYMin = st.startYMin + yDelta; newYMax = st.startYMax + yDelta; }
        const floor = Math.abs(ySpan) * 0.001;
        if (newYMax - newYMin < floor) {
          if (st.mode === "y-min") newYMin = newYMax - floor;
          else if (st.mode === "y-max") newYMax = newYMin + floor;
        }
        st.lastYMin = newYMin;
        st.lastYMax = newYMax;
        // Recompute interval every frame from the new span so the
        // tick density stays roughly constant regardless of drag
        // direction. Without this, ECharts keeps the previously-set
        // interval through the setOption merge and the ruler density
        // looks asymmetric (drag-up vs drag-down).
        patch.yAxis = {
          min: newYMin,
          max: newYMax,
          scale: false,
          interval: niceInterval(newYMax - newYMin, 8),
        };
      }
      if (isXMode && st.startXMin !== undefined && st.startXMax !== undefined && st.xPxRange) {
        const xSpan = st.startXMax - st.startXMin;
        const xSf = xSpan / st.xPxRange;
        const xDelta = -dx * xSf; // drag RIGHT → both bounds decrease
        let newXMin = st.startXMin;
        let newXMax = st.startXMax;
        if (st.mode === "x-min") newXMin = st.startXMin + xDelta;
        else if (st.mode === "x-max") newXMax = st.startXMax + xDelta;
        else { newXMin = st.startXMin + xDelta; newXMax = st.startXMax + xDelta; }
        const floor = Math.abs(xSpan) * 0.001;
        if (newXMax - newXMin < floor) {
          if (st.mode === "x-min") newXMin = newXMax - floor;
          else if (st.mode === "x-max") newXMax = newXMin + floor;
        }
        st.lastXMin = newXMin;
        st.lastXMax = newXMax;
        patch.xAxis = {
          min: newXMin,
          max: newXMax,
          scale: false,
          interval: niceInterval(newXMax - newXMin, 8),
        };
      }
      if (patch.xAxis || patch.yAxis) inst.setOption(patch);
    };

    const finishDrag = (commit: boolean) => {
      const st = dragState;
      if (!st) return;
      dragState = null;
      if (st.captured) {
        try { el.releasePointerCapture(st.pointerId); } catch { /* ignore */ }
      }
      el.style.cursor = "";
      if (!commit || !st.moved) return;
      const cb = onAxisRangeChangeRef.current;
      if (!cb) return;
      const emitsY = st.mode === "y-min" || st.mode === "y-max" || st.mode === "y-pan" || st.mode === "xy-pan";
      const emitsX = st.mode === "x-min" || st.mode === "x-max" || st.mode === "x-pan" || st.mode === "xy-pan";
      if (emitsX && st.lastXMin !== undefined && st.lastXMax !== undefined) {
        cb("x", st.lastXMin, st.lastXMax);
      }
      if (emitsY && st.lastYMin !== undefined && st.lastYMax !== undefined) {
        cb("y", st.lastYMin, st.lastYMax);
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      finishDrag(true);
    };
    const onPointerCancel = (e: PointerEvent) => {
      if (!dragState || e.pointerId !== dragState.pointerId) return;
      finishDrag(false);
    };
    const onPointerLeave = () => {
      if (!dragState) el.style.cursor = "";
    };
    // Global safety net: if for any reason we miss the pointerup
    // (window blur, devtools steal, etc.), end the drag on the next
    // global mouseup so the cursor never gets "stuck".
    const onWindowMouseUpSafety = () => {
      if (dragState && !dragState.captured) finishDrag(true);
    };

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
    el.addEventListener("pointerleave", onPointerLeave);
    window.addEventListener("mouseup", onWindowMouseUpSafety);

    return () => {
      zr.off("dblclick", zrHandler);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
      el.removeEventListener("pointerleave", onPointerLeave);
      window.removeEventListener("mouseup", onWindowMouseUpSafety);
      ro.disconnect();
      inst.dispose();
      chartRef.current = null;
    };
  }, []);

  // 更新选项
  useEffect(() => {
    chartRef.current?.setOption(option as echarts.EChartsCoreOption, true);
  }, [option]);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        background: "var(--bg-card)",
        minHeight,
      }}
    >
      {title && (
        <div
          style={{
            padding: "4px 10px",
            fontSize: 12,
            color: "var(--fg-secondary)",
            background: "var(--bg-header)",
          }}
        >
          {title}
        </div>
      )}
      <div ref={ref} style={{ flex: 1, minHeight: 0 }} />
    </div>
  );
}
