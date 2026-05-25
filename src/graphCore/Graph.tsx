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
}

export function Graph({ spec, data, className, minPanelWidth = 320, minPanelHeight = 240, valueOrders, onYAxisDblClick, onXAxisDblClick }: GraphProps) {
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
}

function GraphPanel({ title, option, minHeight, onYAxisDblClick, onXAxisDblClick }: GraphPanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);
  // Keep the latest callbacks in refs so the Zrender dblclick handler
  // (which we register exactly once on mount) always sees the freshest
  // closure without forcing a re-bind on every prop change.
  const onYAxisDblClickRef = useRef(onYAxisDblClick);
  const onXAxisDblClickRef = useRef(onXAxisDblClick);
  useEffect(() => {
    onYAxisDblClickRef.current = onYAxisDblClick;
  }, [onYAxisDblClick]);
  useEffect(() => {
    onXAxisDblClickRef.current = onXAxisDblClick;
  }, [onXAxisDblClick]);

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

    return () => {
      zr.off("dblclick", zrHandler);
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
