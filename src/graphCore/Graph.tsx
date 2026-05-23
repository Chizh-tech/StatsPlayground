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
}

export function Graph({ spec, data, className, minPanelWidth = 320, minPanelHeight = 240, valueOrders }: GraphProps) {
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
        <GraphPanel key={i} title={p.title} option={p.option} minHeight={minPanelHeight} />
      ))}
    </div>
  );
}

interface GraphPanelProps {
  title: string;
  option: Record<string, unknown>;
  minHeight: number;
}

function GraphPanel({ title, option, minHeight }: GraphPanelProps) {
  const ref = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<echarts.ECharts | null>(null);

  // 初始化 / 销毁
  useEffect(() => {
    if (!ref.current) return;
    const inst = echarts.init(ref.current, undefined, { renderer: "canvas" });
    chartRef.current = inst;
    const ro = new ResizeObserver(() => inst.resize());
    ro.observe(ref.current);
    return () => {
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
