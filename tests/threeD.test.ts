import assert from "node:assert/strict";

import type { GraphTheme } from "../src/graphCore/theme.ts";
import type { GraphData, GraphSpec } from "../src/graphCore/types.ts";
import type { GraphDataFrame } from "../src/types/graphData.ts";

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
});

const { build3DOption } = await import("../src/graphCore/threeD.ts");
const { collectFrame3DPoints } = await import("../src/graphCore/threeDFrame.ts");

const theme: GraphTheme = {
  fgPrimary: "#111111",
  fgSecondary: "#333333",
  fgDim: "#666666",
  accent: "#0066cc",
  gridLine: "#eeeeee",
  gridLineMajor: "#dddddd",
  axisLine: "#999999",
  bgCanvas: "#ffffff",
  categorical: ["#0066cc"],
  sequential: ["#eeeeee", "#0066cc"],
};

const spec: GraphSpec = {
  encoding: {
    x: { name: "x", type: "quantitative" },
    y: { name: "y", type: "quantitative" },
    z: { name: "z", type: "quantitative" },
  },
  elements: [{
    kind: "scatter3d",
    options: {
      summaryStat: "mean",
      errorInterval: "stdErr",
      intervalStyle: "errorBar",
    },
  }],
};

const data: GraphData = {
  columns: ["x", "y", "z"],
  rows: [
    [1, 2, 10],
    [1, 2, 14],
  ],
};

const result = build3DOption(spec, data, theme);
assert.ok(result.option);

const series = result.option.series as Array<Record<string, unknown>>;
assert.equal(series.some((item) => item.type === "lines3D"), false);

const intervalSeries = series.filter((item) => item.type === "line3D");
assert.equal(intervalSeries.length, 1);
assert.deepEqual(intervalSeries[0].data, [[1, 2, 10], [1, 2, 14]]);

const throwingRows = new Proxy([] as unknown[][], {
  get(_target, prop) {
    if (prop === "length") return 2;
    throw new Error("legacy rows access is forbidden for frame-backed 3D");
  },
});

const frame3dData: GraphData = {
  columns: ["x", "y", "z"],
  rows: throwingRows,
};

const frame3d: GraphDataFrame = {
  requestId: "req-3d",
  datasetId: "ds-3d",
  generation: 1,
  sourceRows: 2,
  processedRows: 2,
  sampling: { mode: "full" },
  dictionaries: {},
  extents: {},
  aggregates: [],
  rawChunks: [
    {
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 2,
      xValues: new Float64Array([1, 1]),
      yValues: new Float64Array([2, 2]),
      zValues: new Float64Array([10, 14]),
      rowIds: new BigInt64Array([1n, 2n]),
      validity: {
        x: new Uint8Array([0b00000011]),
        y: new Uint8Array([0b00000011]),
        z: new Uint8Array([0b00000011]),
      },
    },
  ],
};

const frameResult = build3DOption(spec, frame3dData, theme, frame3d);
assert.ok(frameResult.option);
const frameSeries = frameResult.option.series as Array<Record<string, unknown>>;
assert.equal(frameSeries.some((item) => item.type === "scatter3D"), true);

const crossByteFrame: GraphDataFrame = {
  requestId: "req-3d-cross-byte",
  datasetId: "ds-3d-cross-byte",
  generation: 1,
  sourceRows: 10,
  processedRows: 10,
  sampling: { mode: "full" },
  dictionaries: { group: ["G0", "G1"] },
  extents: {},
  aggregates: [],
  rawChunks: [
    {
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 10,
      xValues: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
      yValues: new Float64Array([11, 12, 13, 14, 15, 16, 17, 18, 19, 20]),
      zValues: new Float64Array([21, 22, 23, 24, 25, 26, 27, 28, 29, 30]),
      groupCodes: new Uint32Array([0, 1, 0, 1, 0, 1, 0, 1, 0, 1]),
      rowIds: new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]),
      validity: {
        x: new Uint8Array([0b00000001, 0b00000001]),
        y: new Uint8Array([0b00000001, 0b00000010]),
        z: new Uint8Array([0b00000001, 0b00000011]),
        group: new Uint8Array([0b00000001, 0b00000011]),
      },
    },
  ],
};

const crossByteResult = build3DOption(spec, frame3dData, theme, crossByteFrame);
const crossByteSeries = (crossByteResult.option.series as Array<Record<string, unknown>>)
  .find((item) => item.type === "scatter3D");
assert.ok(crossByteSeries);
const crossBytePoints = crossByteSeries.data as number[][];
assert.equal(crossBytePoints.length, 1);
assert.deepEqual(crossBytePoints[0], [1, 11, 21]);

const frameWithTruncatedRowIds: GraphDataFrame = {
  requestId: "req-3d-truncated-rowids",
  datasetId: "ds-3d-truncated-rowids",
  generation: 1,
  sourceRows: 3,
  processedRows: 3,
  sampling: { mode: "full" },
  dictionaries: {},
  extents: {},
  aggregates: [],
  rawChunks: [
    {
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 3,
      xValues: new Float64Array([1, 2, 3]),
      yValues: new Float64Array([10, 20, 30]),
      zValues: new Float64Array([100, 200, 300]),
      rowIds: new BigInt64Array([]),
      validity: {
        x: new Uint8Array([0b00000111]),
        y: new Uint8Array([0b00000111]),
        z: new Uint8Array([0b00000111]),
      },
    },
  ],
};

const loose3dPoints = collectFrame3DPoints(frameWithTruncatedRowIds);
assert.equal(loose3dPoints.length, 3);
assert.deepEqual(loose3dPoints.map((point) => [point.x, point.y, point.z]), [
  [1, 10, 100],
  [2, 20, 200],
  [3, 30, 300],
]);

const surfaceData: GraphData = {
  columns: ["x", "y", "z"],
  rows: [
    [0, 0, 0], [1, 0, 0], [2, 0, 0],
    [0, 1, 0], [1, 1, 80], [1, 1, 120], [2, 1, 0],
    [0, 2, 0], [1, 2, 0],
  ],
};

const buildSurface = (smoothness?: number) => build3DOption({
  encoding: spec.encoding,
  elements: [{
    kind: "surface",
    options: {
      stat: "mean",
      ...(smoothness === undefined ? {} : { smoothness }),
    },
  }],
}, surfaceData, theme);

const rawSurface = buildSurface();
assert.ok(rawSurface.option);
const rawSeries = (rawSurface.option.series as Array<Record<string, unknown>>)
  .find((item) => item.type === "surface");
assert.ok(rawSeries);
assert.deepEqual(rawSeries.dataShape, [3, 3]);

const rawVertices = rawSeries.data as number[][];
assert.equal(rawVertices.length, 9);
assert.equal(rawVertices[4][2], 100);
assert.equal(Number.isNaN(rawVertices[8][2]), true);

// Previously smoothing modified geometry; now smoothing is visual-only.
const smoothSurface = buildSurface(1);
assert.ok(smoothSurface.option);
const smoothSeries = (smoothSurface.option.series as Array<Record<string, unknown>>)
  .find((item) => item.type === "surface");
assert.ok(smoothSeries);
const smoothVertices = smoothSeries.data as number[][];
// Geometry must be identical, hole preserved.
assert.deepEqual(rawVertices, smoothVertices);
assert.equal(Number.isNaN(smoothVertices[8][2]), true);

// Both surface series use Lambert shading and grid3D light intensities map to
// visual smoothness: s=0 -> (1.2,0.3), s=1 -> (0.3,0.9).
assert.equal((rawSeries as any).shading, "lambert");
assert.equal((smoothSeries as any).shading, "lambert");
const rawLight = (rawSurface.option as any).grid3D.light as any;
const smoothLight = (smoothSurface.option as any).grid3D.light as any;
const EPS = 1e-12;
assert.ok(Math.abs(rawLight.main.intensity - 1.2) < EPS);
assert.ok(Math.abs(rawLight.ambient.intensity - 0.3) < EPS);
assert.ok(Math.abs(smoothLight.main.intensity - 0.3) < EPS);
assert.ok(Math.abs(smoothLight.ambient.intensity - 0.9) < EPS);

// New: visualMap configuration must remain for emitted Lambert Surface.
// It should be an array of continuous visualMaps with dimension 2, include
// the surface series index, and preserve the color gradient array.
const vmap = (smoothSurface.option as any).visualMap as any[] | undefined;
assert.ok(Array.isArray(vmap));
const firstVM = vmap[0];
assert.equal(firstVM.type, "continuous");
assert.equal(firstVM.dimension, 2);
// seriesIndex may be an array — ensure it contains the surface series index.
const vmSeriesIndex = firstVM.seriesIndex as number[] | number;
const surfaceIndex = (smoothSurface.option as any).series.findIndex((s: any) => s.type === "surface");
assert.ok(Array.isArray(vmSeriesIndex) ? vmSeriesIndex.includes(surfaceIndex) : vmSeriesIndex === surfaceIndex);
// Color gradient retained — compare shape and approximate colors via toString
assert.ok(Array.isArray(firstVM.inRange?.color) && firstVM.inRange.color.length === 3);

// Scatter-only scene keeps main/ambient defaults 1.2/0.3
const scatterOnly = build3DOption({ encoding: spec.encoding, elements: [spec.elements[0]] }, data, theme);
assert.ok(scatterOnly.option);
const scatterLight = (scatterOnly.option as any).grid3D.light as any;
assert.ok(Math.abs(scatterLight.main.intensity - 1.2) < EPS);
assert.ok(Math.abs(scatterLight.ambient.intensity - 0.3) < EPS);

// Smoothness normalization: below 0 -> 0, above 1 -> 1, non-finite -> 0
const below = buildSurface(-0.5);
const above = buildSurface(2);
const nan = buildSurface(Number.NaN);
const inf = buildSurface(Infinity);
const belowLight = (below.option as any).grid3D.light as any;
const aboveLight = (above.option as any).grid3D.light as any;
const nanLight = (nan.option as any).grid3D.light as any;
const infLight = (inf.option as any).grid3D.light as any;
// below equals s=0
assert.ok(Math.abs(belowLight.main.intensity - rawLight.main.intensity) < EPS);
assert.ok(Math.abs(belowLight.ambient.intensity - rawLight.ambient.intensity) < EPS);
// above equals s=1
assert.ok(Math.abs(aboveLight.main.intensity - smoothLight.main.intensity) < EPS);
assert.ok(Math.abs(aboveLight.ambient.intensity - smoothLight.ambient.intensity) < EPS);
// non-finite -> treated as 0
assert.ok(Math.abs(nanLight.main.intensity - rawLight.main.intensity) < EPS);
assert.ok(Math.abs(nanLight.ambient.intensity - rawLight.ambient.intensity) < EPS);
assert.ok(Math.abs(infLight.main.intensity - rawLight.main.intensity) < EPS);
assert.ok(Math.abs(infLight.ambient.intensity - rawLight.ambient.intensity) < EPS);

const contourData: GraphData = {
  columns: ["x", "y", "z"],
  rows: [
    [0, 0, 0], [1, 0, 1], [2, 0, 2],
    [0, 1, 1], [1, 1, 2], [2, 1, 3],
    [0, 2, 2], [1, 2, 3], [2, 2, 4],
  ],
};

const contourResult = build3DOption({
  encoding: spec.encoding,
  elements: [{
    kind: "contour3d",
    options: { stat: "mean", smoothness: 0, levels: 3 },
  }],
}, contourData, theme);
assert.ok(contourResult.option);
const contourSeries = (contourResult.option.series as Array<Record<string, unknown>>)
  .filter((item) => String(item.name).includes("__contour_"));
assert.equal(contourSeries.length, 3);
assert.ok(contourSeries.every((item) => item.type === "line3D"));
assert.ok(contourSeries.every((item) => {
  const points = item.data as number[][];
  return points.length >= 2 && points.every((point) => point.every(Number.isFinite));
}));
const contourLevels = contourSeries.map((item) => Number(String(item.name).split("__contour_")[1]?.split("_")[0]));
assert.deepEqual(contourLevels, [1, 2, 3]);
assert.ok(contourSeries.every((item, index) => {
  const points = item.data as number[][];
  return points.every((point) => point[2] > contourLevels[index]);
}));

const groupedContourData: GraphData = {
  columns: ["x", "y", "z", "group"],
  rows: [
    ...contourData.rows.map((row) => [...row, "A"]),
    ...contourData.rows.map((row) => [row[0], row[1], Number(row[2]) + 10, "B"]),
  ],
};
const groupedContourResult = build3DOption({
  encoding: {
    ...spec.encoding,
    overlay: { name: "group", type: "nominal" },
  },
  elements: [
    { kind: "surface", options: { stat: "mean", smoothness: 0 } },
    { kind: "contour3d", options: { stat: "mean", smoothness: 0, levels: 3 } },
  ],
  styles: {
    A: { gradient: { color: "#cc0000" } },
    B: { gradient: { color: "#0000cc" } },
  },
  hiddenGroups: ["B"],
}, groupedContourData, theme);
assert.ok(groupedContourResult.option);
const groupedSeries = groupedContourResult.option.series as Array<Record<string, unknown>>;
const visibleContours = groupedSeries.filter((item) => String(item.name).includes("__contour_"));
assert.equal(visibleContours.length, 3);
assert.ok(visibleContours.every((item) => String(item.name).startsWith("A__contour_")));
assert.ok(visibleContours.every((item) => (item.lineStyle as Record<string, unknown>).color === "#cc0000"));
assert.equal(groupedSeries.filter((item) => item.type === "surface").length, 1);
const contourIndexes = new Set(groupedSeries
  .map((item, index) => String(item.name).includes("__contour_") ? index : -1)
  .filter((index) => index >= 0));
const visualMaps = groupedContourResult.option.visualMap as Array<Record<string, unknown>>;
assert.ok(visualMaps.every((visualMap) =>
  (visualMap.seriesIndex as number[]).every((index) => !contourIndexes.has(index))));

const frameContour: GraphDataFrame = {
  requestId: "req-3d-contour",
  datasetId: "ds-3d-contour",
  generation: 1,
  sourceRows: 18,
  processedRows: 18,
  sampling: { mode: "full" },
  dictionaries: { group: ["A", "B"] },
  extents: {},
  aggregates: [],
  rawChunks: [{
    chunkIndex: 0,
    rowOffset: 0,
    rowCount: 18,
    xValues: new Float64Array([0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2]),
    yValues: new Float64Array([0, 0, 0, 1, 1, 1, 2, 2, 2, 0, 0, 0, 1, 1, 1, 2, 2, 2]),
    zValues: new Float64Array([0, 1, 2, 1, 2, 3, 2, 3, 4, 10, 11, 12, 11, 12, 13, 12, 13, 14]),
    groupCodes: new Uint32Array([0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1]),
    rowIds: new BigInt64Array([]),
    validity: {
      x: new Uint8Array([0xff, 0xff, 0x03]),
      y: new Uint8Array([0xff, 0xff, 0x03]),
      z: new Uint8Array([0xff, 0xff, 0x03]),
      group: new Uint8Array([0xff, 0xff, 0x03]),
    },
  }],
};
const frameContourResult = build3DOption({
  encoding: {
    ...spec.encoding,
    overlay: { name: "group", type: "nominal" },
  },
  elements: [{ kind: "contour3d", options: { levels: 3 } }],
  styles: {
    A: { gradient: { color: "#cc0000" } },
    B: { gradient: { color: "#0000cc" } },
  },
  hiddenGroups: ["B"],
}, frame3dData, theme, frameContour);
assert.ok(frameContourResult.option);
const frameContours = (frameContourResult.option.series as Array<Record<string, unknown>>)
  .filter((item) => String(item.name).includes("__contour_"));
assert.equal(frameContours.length, 3);
assert.ok(frameContours.every((item) => item.type === "line3D"));
assert.ok(frameContours.every((item) => String(item.name).startsWith("A__contour_")));
assert.ok(frameContours.every((item) => (item.lineStyle as Record<string, unknown>).color === "#cc0000"));
assert.ok(frameContours.every((item) =>
  (item.data as number[][]).length >= 2
    && (item.data as number[][]).every((point) => point.every(Number.isFinite))));

console.log("threeD regressions passed");