import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import type { EChartsOption } from "echarts";

interface FitModelDiagnosticChartProps {
  option: EChartsOption;
  title: string;
  chartKind: "actualByPredicted" | "residualByPredicted";
}

export function FitModelDiagnosticChart({ option, title, chartKind }: FitModelDiagnosticChartProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const instance = echarts.init(container, undefined, { renderer: "canvas" });
    const update = () => {
      instance.setOption(option, { notMerge: true });
    };

    update();
    const observer = new ResizeObserver(() => instance.resize());
    observer.observe(container);

    const themeObserver = new MutationObserver(update);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "data-theme"] });

    return () => {
      observer.disconnect();
      themeObserver.disconnect();
      instance.dispose();
    };
  }, [option]);

  return (
    <div
      ref={containerRef}
      role="img"
      aria-label={title}
      data-chart-kind={chartKind}
      style={{
        width: "100%",
        minWidth: 0,
        boxSizing: "border-box",
        height: "clamp(220px, 30vw, 260px)",
        minHeight: "220px",
        maxHeight: "260px",
      }}
    />
  );
}