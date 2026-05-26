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

    // ----- Y / X axis drag-zoom & drag-pan ---------------------------
    // JMP-style direct manipulation on the axis strip:
    //   • grab the OUTER thirds of the axis (the two ends) and drag to
    //     stretch/shrink that end of the range — zoom in/out from one
    //     side without moving the other,
    //   • grab the MIDDLE third and drag to pan: both bounds shift by
    //     the same amount so the visible window scrolls.
    // During the drag we preview by calling `setOption` directly on the
    // ECharts instance (no React rerender per frame, so the gesture
    // stays at 60fps); on mouseup we read the final bounds back from
    // the chart and emit them through `onAxisRangeChange` so the
    // builder pins them into project state and they survive future
    // re-renders. Skipped on category axes (min/max don't apply) and
    // on inverted axes (sign conventions would need flipping; rare
    // enough to defer).
    //
    // The pixel-to-data sensitivity uses the GRID rect's width / height
    // so the resulting drag matches what the user sees on screen —
    // dragging one full grid-height vertically moves the Y range by
    // exactly one full span.
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
    type Grip = {
      axis: "x" | "y";
      mode: "min" | "max" | "pan";
      startMin: number;
      startMax: number;
      axisPxRange: number;
    };
    /** Classify a panel-local pixel into which axis strip (if any) it
     *  sits in and which third of that strip (min / pan / max). Returns
     *  the sensitivity-calculation inputs the drag handler needs, or
     *  null when the gesture doesn't apply (outside strips, category
     *  axis, inverted axis, conversion failure). */
    const getAxisGrip = (px: number, py: number): Grip | null => {
      const r = getGridRect();
      if (!r) return null;
      const el = ref.current;
      const panelH = el?.clientHeight ?? 0;
      // Y axis strip: LEFT of the grid (axis labels + line), vertically
      // clamped to the grid so a click far above / below doesn't
      // accidentally start a drag.
      const inYStrip = px >= 0 && px < r.x && py >= r.y && py <= r.y + r.height;
      // X axis strip: BELOW the grid (ticks + labels + optional name),
      // horizontally clamped to the grid range.
      const inXStrip = py > r.y + r.height && py <= panelH && px >= r.x && px <= r.x + r.width;
      if (!inYStrip && !inXStrip) return null;
      const which: "x" | "y" = inYStrip ? "y" : "x";
      const axisType = getAxisType(which);
      if (axisType === "category") return null;
      if (isAxisInverse(which)) return null;
      // Zone via screen-space position relative to the axis pixel
      // extent. Outer 30% on each end = handle, inner 40% = pan.
      const pxAlongAxis = which === "y" ? py - r.y : px - r.x;
      const span = which === "y" ? r.height : r.width;
      const t = pxAlongAxis / span; // 0..1
      let mode: "min" | "max" | "pan";
      if (which === "y") {
        // Y screen: top = max, bottom = min.
        if (t < 0.3) mode = "max";
        else if (t > 0.7) mode = "min";
        else mode = "pan";
      } else {
        // X screen: left = min, right = max.
        if (t < 0.3) mode = "min";
        else if (t > 0.7) mode = "max";
        else mode = "pan";
      }
      // Read current data min/max via convertFromPixel at the grid
      // corners. ECharts' single-axis finder accepts a number along
      // that axis and returns the data value.
      let topOrLeftVal: unknown;
      let botOrRightVal: unknown;
      try {
        if (which === "y") {
          topOrLeftVal = inst.convertFromPixel({ yAxisIndex: 0 }, r.y);
          botOrRightVal = inst.convertFromPixel({ yAxisIndex: 0 }, r.y + r.height);
        } else {
          topOrLeftVal = inst.convertFromPixel({ xAxisIndex: 0 }, r.x);
          botOrRightVal = inst.convertFromPixel({ xAxisIndex: 0 }, r.x + r.width);
        }
      } catch {
        return null;
      }
      const startMax = which === "y" ? Number(topOrLeftVal) : Number(botOrRightVal);
      const startMin = which === "y" ? Number(botOrRightVal) : Number(topOrLeftVal);
      if (!Number.isFinite(startMin) || !Number.isFinite(startMax) || startMax <= startMin) {
        return null;
      }
      return { axis: which, mode, startMin, startMax, axisPxRange: span };
    };

    // Drag state machine. The pointer-move and pointer-up handlers live
    // on `window` while a drag is active so the gesture continues even
    // if the cursor briefly leaves the chart panel.
    type DragState = Grip & { startEventPx: number; moved: boolean; lastMin: number; lastMax: number };
    let dragState: DragState | null = null;
    const DRAG_THRESHOLD_PX = 3;

    const zrMouseDown = (e: { offsetX: number; offsetY: number; event?: { preventDefault?: () => void } }) => {
      if (!onAxisRangeChangeRef.current) return;
      const grip = getAxisGrip(e.offsetX, e.offsetY);
      if (!grip) return;
      dragState = {
        ...grip,
        startEventPx: grip.axis === "y" ? e.offsetY : e.offsetX,
        moved: false,
        lastMin: grip.startMin,
        lastMax: grip.startMax,
      };
      // Avoid the browser highlighting page text while the mouse moves
      // across the chart strip during a drag.
      e.event?.preventDefault?.();
      window.addEventListener("mousemove", onWinMove);
      window.addEventListener("mouseup", onWinUp);
    };

    const onWinMove = (e: MouseEvent) => {
      const st = dragState;
      if (!st) return;
      const el = ref.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const curPx = st.axis === "y" ? e.clientY - rect.top : e.clientX - rect.left;
      const pixelDelta = curPx - st.startEventPx;
      if (!st.moved && Math.abs(pixelDelta) >= DRAG_THRESHOLD_PX) st.moved = true;
      if (!st.moved) return;
      const span = st.startMax - st.startMin;
      const sf = span / st.axisPxRange;
      let newMin = st.startMin;
      let newMax = st.startMax;
      if (st.axis === "y") {
        // Y screen: top = max, bottom = min. Drag DOWN = +pixelDelta.
        if (st.mode === "min") {
          // Bottom (min) handle: drag DOWN → stretches axis to lower
          // values → min decreases.
          newMin = st.startMin - pixelDelta * sf;
        } else if (st.mode === "max") {
          // Top (max) handle: drag DOWN → shrinks axis from top → max
          // decreases. Drag UP → max increases.
          newMax = st.startMax - pixelDelta * sf;
        } else {
          // Pan: content follows finger → dragging DOWN shows higher
          // values at the top → both bounds INCREASE.
          newMin = st.startMin + pixelDelta * sf;
          newMax = st.startMax + pixelDelta * sf;
        }
      } else {
        // X screen: left = min, right = max. Drag RIGHT = +pixelDelta.
        if (st.mode === "min") {
          // Left (min) handle: drag RIGHT (inward) → min increases
          // (zoom in from left). Drag LEFT (outward) → min decreases.
          newMin = st.startMin + pixelDelta * sf;
        } else if (st.mode === "max") {
          // Right (max) handle: drag RIGHT (outward) → max increases.
          newMax = st.startMax + pixelDelta * sf;
        } else {
          // Pan: content follows finger → dragging RIGHT shows lower
          // values on the right → both bounds DECREASE.
          newMin = st.startMin - pixelDelta * sf;
          newMax = st.startMax - pixelDelta * sf;
        }
      }
      // Block over-compression: don't let either handle cross over the
      // other. Snap to a tiny floor at 0.1% of the original span so the
      // chart never tries to render an inverted / collapsed range.
      const minSpan = Math.abs(span) * 0.001;
      if (newMax - newMin < minSpan) {
        if (st.mode === "min") newMin = newMax - minSpan;
        else if (st.mode === "max") newMax = newMin + minSpan;
        else return; // pan can't collapse; skip the no-op frame.
      }
      st.lastMin = newMin;
      st.lastMax = newMax;
      // Live preview — setOption merges (default) so we keep all the
      // other axis settings (lineStyle, splitLine, …) untouched.
      // `scale: false` keeps ECharts from padding the bounds outward.
      if (st.axis === "y") {
        inst.setOption({ yAxis: { min: newMin, max: newMax, scale: false } });
      } else {
        inst.setOption({ xAxis: { min: newMin, max: newMax, scale: false } });
      }
    };

    const onWinUp = () => {
      const st = dragState;
      dragState = null;
      window.removeEventListener("mousemove", onWinMove);
      window.removeEventListener("mouseup", onWinUp);
      // Don't commit if the user clicked but didn't drag (e.g., the
      // gesture was actually the first half of a double-click that
      // opens the dialog). Pixel-threshold guard above keeps `moved`
      // false in that case.
      if (!st || !st.moved) return;
      onAxisRangeChangeRef.current?.(st.axis, st.lastMin, st.lastMax);
    };

    zr.on("mousedown", zrMouseDown);

    return () => {
      zr.off("dblclick", zrHandler);
      zr.off("mousedown", zrMouseDown);
      window.removeEventListener("mousemove", onWinMove);
      window.removeEventListener("mouseup", onWinUp);
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
