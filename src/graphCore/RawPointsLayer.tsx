import { useEffect, useRef } from "react";
import * as echarts from "echarts";
import {
  buildPixelIndex,
  computeCanvasBackingStore,
  drawRawPoints,
  resetAndScaleCanvasContext,
  type CategoricalProjector,
  type NumericProjector,
  type RawPointPanelDescriptor,
  type RawPointPixelIndex,
  type RawPointProjector,
} from "./rawPoints";
import { GRAPH_RAW_CANVAS_Z_INDEX } from "./layers";

interface RawPointsLayerProps {
  chart: echarts.ECharts | null;
  descriptor: RawPointPanelDescriptor | null;
  onIndexChange?: (index: RawPointPixelIndex | null) => void;
}

function getGridRect(chart: echarts.ECharts): { x: number; y: number; width: number; height: number } | null {
  try {
    const grid = (chart as unknown as { getModel?: () => { getComponent?: (t: string, i: number) => unknown } })
      .getModel?.()
      ?.getComponent?.("grid", 0) as
      | { coordinateSystem?: { getRect?: () => { x: number; y: number; width: number; height: number } } }
      | undefined;
    return grid?.coordinateSystem?.getRect?.() ?? null;
  } catch {
    return null;
  }
}

function numericProjectorFromPixels(
  p1: { pixel: number; value: number },
  p2: { pixel: number; value: number },
): NumericProjector | null {
  const dv = p2.value - p1.value;
  if (!Number.isFinite(p1.pixel) || !Number.isFinite(p2.pixel) || !Number.isFinite(dv) || Math.abs(dv) < 1e-12) {
    return null;
  }
  const scale = (p2.pixel - p1.pixel) / dv;
  const offset = p1.pixel - scale * p1.value;
  if (!Number.isFinite(scale) || !Number.isFinite(offset)) return null;
  return { kind: "numeric", scale, offset };
}

function buildProjector(
  chart: echarts.ECharts,
  descriptor: RawPointPanelDescriptor,
): RawPointProjector | null {
  const rect = getGridRect(chart);
  if (!rect || rect.width <= 0 || rect.height <= 0) return null;

  let xProjector: NumericProjector | CategoricalProjector | null = null;
  const firstChunk = descriptor.chunks[0];
  const isCategorical = firstChunk?.xValues instanceof Uint32Array;
  if (isCategorical) {
    const cats = descriptor.xCategories;
    if (!cats || cats.length === 0) return null;
    const pixelsByCategory = new Float64Array(cats.length);
    pixelsByCategory.fill(Number.NaN);
    for (let i = 0; i < cats.length; i += 1) {
      const px = Number(chart.convertToPixel({ xAxisIndex: 0 }, cats[i]));
      if (Number.isFinite(px)) pixelsByCategory[i] = px;
    }
    xProjector = { kind: "categorical", pixelsByCategory };
  } else {
    const xLeftVal = Number(chart.convertFromPixel({ xAxisIndex: 0 }, rect.x));
    const xRightVal = Number(chart.convertFromPixel({ xAxisIndex: 0 }, rect.x + rect.width));
    xProjector = numericProjectorFromPixels(
      { pixel: rect.x, value: xLeftVal },
      { pixel: rect.x + rect.width, value: xRightVal },
    );
  }
  if (!xProjector) return null;

  const yTopVal = Number(chart.convertFromPixel({ yAxisIndex: 0 }, rect.y));
  const yBottomVal = Number(chart.convertFromPixel({ yAxisIndex: 0 }, rect.y + rect.height));
  const yProjector = numericProjectorFromPixels(
    { pixel: rect.y, value: yTopVal },
    { pixel: rect.y + rect.height, value: yBottomVal },
  );
  if (!yProjector) return null;

  return {
    plotRect: {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.max(1, Math.round(rect.width)),
      height: Math.max(1, Math.round(rect.height)),
    },
    x: xProjector,
    y: yProjector,
  };
}

export function RawPointsLayer({ chart, descriptor, onIndexChange }: RawPointsLayerProps) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const host = canvas.parentElement;
    if (!host) return;

    let frame = 0;
    const render = () => {
      frame = 0;
      const backing = computeCanvasBackingStore(
        host.clientWidth,
        host.clientHeight,
        window.devicePixelRatio || 1,
      );
      const w = backing.cssWidth;
      const h = backing.cssHeight;
      if (canvas.width !== backing.pixelWidth) canvas.width = backing.pixelWidth;
      if (canvas.height !== backing.pixelHeight) canvas.height = backing.pixelHeight;
      const cssWidth = `${w}px`;
      const cssHeight = `${h}px`;
      if (canvas.style.width !== cssWidth) canvas.style.width = cssWidth;
      if (canvas.style.height !== cssHeight) canvas.style.height = cssHeight;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      resetAndScaleCanvasContext(ctx, backing);

      if (!chart || !descriptor) {
        onIndexChange?.(null);
        return;
      }

      const projector = buildProjector(chart, descriptor);
      if (!projector) {
        onIndexChange?.(null);
        return;
      }

      const drawn = drawRawPoints(descriptor, projector);
      ctx.fillStyle = "rgba(26, 131, 255, 0.95)";
      for (let i = 0; i < drawn.points.length; i += 1) {
        const p = drawn.points[i];
        if (p.px < 0 || p.py < 0 || p.px >= w || p.py >= h) continue;
        ctx.fillRect(p.px, p.py, 1, 1);
      }

      const index = buildPixelIndex(w, h, drawn.points);
      onIndexChange?.(index);
    };

    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(render);
    };

    const ro = new ResizeObserver(schedule);
    ro.observe(host);

    const zr = chart?.getZr();
    zr?.on("rendered", schedule);

    schedule();

    return () => {
      if (frame) cancelAnimationFrame(frame);
      zr?.off("rendered", schedule);
      ro.disconnect();
    };
  }, [chart, descriptor, onIndexChange]);

  return (
    <canvas
      ref={canvasRef}
      style={{
        position: "absolute",
        inset: 0,
        pointerEvents: "none",
        zIndex: GRAPH_RAW_CANVAS_Z_INDEX,
      }}
    />
  );
}
