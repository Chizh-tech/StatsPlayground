/** Graph Core 模块出口 */
export { Graph } from "./Graph";
export { RawPointsLayer } from "./RawPointsLayer";
export { getGraphTheme, buildAxisCommon } from "./theme";
export { buildGraph, isMissing, type BuiltGraph, type ScatterPointPick } from "./transform";
export {
  drawRawPoints,
  buildPixelIndex,
  hitTestPoint,
  hitTestBrush,
  rasterizeToRgba,
  stableRgbaDigest,
  type RawPointChunkViews,
  type RawPointPanelDescriptor,
  type RawPointProjector,
  type RawPointPixelIndex,
} from "./rawPoints";
export {
  inferFieldType,
  DEFAULT_GROUP_KEY,
  type FieldRef,
  type FieldType,
  type Encoding,
  type ChartElement,
  type ElementKind,
  type GraphSpec,
  type GraphData,
  type SmootherOptions,
  type RawPointJitterOptions,
  type MarkStyle,
  type GroupStyle,
  type GroupStyleMap,
  type MarkerShape,
  type RefLineY,
  type RefLineX,
  type RefLineStyle,
  type BandRefLine,
  type YAxisConfig,
  type GridLineStyle,
  type AutoSpec,
} from "./types";
