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

console.log("threeD summary interval regression passed");