export const GRAPH_SERIES_BASE_ZLEVEL = 0;
export const GRAPH_SERIES_OVERLAY_ZLEVEL = 10;
export const GRAPH_RAW_CANVAS_Z_INDEX = 5;

interface GraphOptionLike {
  series?: unknown;
  [key: string]: unknown;
}

interface SeriesLike {
  id?: unknown;
  zlevel?: unknown;
  markLine?: unknown;
  [key: string]: unknown;
}

interface LayerLike {
  dom?: { style?: { zIndex?: string } };
}

function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function hasShowTrue(value: unknown): boolean {
  return !!value && typeof value === "object" && (value as { show?: unknown }).show === true;
}

function hasVisibleSeriesLabel(series: SeriesLike): boolean {
  const coreSeries = series as SeriesLike & {
    label?: unknown;
    endLabel?: unknown;
    upperLabel?: unknown;
    emphasis?: { label?: unknown; endLabel?: unknown; upperLabel?: unknown };
    select?: { label?: unknown; endLabel?: unknown; upperLabel?: unknown };
    blur?: { label?: unknown; endLabel?: unknown; upperLabel?: unknown };
  };
  if (hasShowTrue(coreSeries.label) || hasShowTrue(coreSeries.endLabel) || hasShowTrue(coreSeries.upperLabel)) {
    return true;
  }
  const states = [coreSeries.emphasis, coreSeries.select, coreSeries.blur];
  for (const state of states) {
    if (!state || typeof state !== "object") continue;
    if (hasShowTrue(state.label) || hasShowTrue(state.endLabel) || hasShowTrue(state.upperLabel)) {
      return true;
    }
  }
  return false;
}

function isOverlayCarrier(series: SeriesLike): boolean {
  const id = typeof series.id === "string" ? series.id : "";
  if (id.startsWith("__ref_lines_")) return true;
  if (id.startsWith("__band_ref_lines_")) return true;
  if (id.endsWith("__fitstats")) return true;
  if (series.markLine && typeof series.markLine === "object") return true;
  if (hasVisibleSeriesLabel(series)) return true;
  return false;
}

function withSeriesLayer(series: SeriesLike): SeriesLike {
  const current = asNumber(series.zlevel);
  if (isOverlayCarrier(series)) {
    const overlay = current == null
      ? GRAPH_SERIES_OVERLAY_ZLEVEL
      : Math.max(current, GRAPH_SERIES_OVERLAY_ZLEVEL);
    return { ...series, zlevel: overlay };
  }
  const base = current == null ? GRAPH_SERIES_BASE_ZLEVEL : current;
  return { ...series, zlevel: base };
}

export function withInterleavedGraphLayers(option: GraphOptionLike): GraphOptionLike {
  if (!Array.isArray(option.series)) return option;
  const nextSeries = option.series.map((s) => {
    if (!s || typeof s !== "object") return s;
    return withSeriesLayer(s as SeriesLike);
  });
  return { ...option, series: nextSeries };
}

function toFiniteZLevel(input: string): number | null {
  const n = Number(input);
  return Number.isFinite(n) ? n : null;
}

export function applyZrenderCanvasZIndices(
  layers: Record<string, LayerLike> | null | undefined,
): number {
  if (!layers) return 0;
  const sorted = Object.entries(layers)
    .map(([key, layer]) => ({ zlevel: toFiniteZLevel(key), layer }))
    .filter((entry): entry is { zlevel: number; layer: LayerLike } => entry.zlevel != null)
    .sort((a, b) => a.zlevel - b.zlevel);
  let applied = 0;
  for (const entry of sorted) {
    const style = entry.layer.dom?.style;
    if (!style) continue;
    style.zIndex = String(entry.zlevel);
    applied += 1;
  }
  return applied;
}
