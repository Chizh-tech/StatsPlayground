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

const smoothSurface = buildSurface(0.5);
assert.ok(smoothSurface.option);
const smoothSeries = (smoothSurface.option.series as Array<Record<string, unknown>>)
  .find((item) => item.type === "surface");
assert.ok(smoothSeries);
const smoothVertices = smoothSeries.data as number[][];
assert.ok(smoothVertices[4][2] < 100);
assert.equal(Number.isNaN(smoothVertices[8][2]), true);

console.log("threeD regressions passed");