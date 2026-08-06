import assert from "node:assert/strict";

import type { GraphTheme } from "../src/graphCore/theme";
import type { GraphData, GraphSpec } from "../src/graphCore/types";

Object.defineProperty(globalThis, "localStorage", {
  value: {
    getItem: () => null,
    setItem: () => undefined,
    removeItem: () => undefined,
  },
});

const { build3DOption } = await import("../src/graphCore/threeD");

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

console.log("threeD regressions passed");