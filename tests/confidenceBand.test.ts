import assert from "node:assert/strict";

import { buildBandSeries } from "../src/graphCore/confidenceBand.ts";

const lower: [number, number][] = [
  [1, 10],
  [2, 20],
  [3, 30],
];
const upper: [number, number][] = [
  [1, 14],
  [2, 25],
  [3, 36],
];

const series = buildBandSeries(lower, upper, "#7655c5", 0.18, "fit");
assert.equal(series.length, 1);
assert.equal(series[0].type, "custom");
assert.equal(series[0].clip, true);
assert.deepEqual(series[0].data, [...lower, ...upper]);

const shape = series[0].renderItem({}, {
  coord: ([x, y]: [number, number]) => [x * 10, y * 10],
});

assert.equal(shape.type, "polygon");
assert.deepEqual(shape.shape.points, [
  [10, 100],
  [20, 200],
  [30, 300],
  [30, 360],
  [20, 250],
  [10, 140],
]);
assert.deepEqual(shape.style, {
  fill: "#7655c5",
  opacity: 0.18,
});
assert.equal(series[0].renderItem({ dataIndex: 1 }, {
  coord: ([x, y]: [number, number]) => [x, y],
}), null);

const transposedShape = series[0].renderItem({ seriesId: "__fit_band_fit__t" }, {
  coord: ([x, y]: [number, number]) => [x * 10, y * 10],
});
assert.deepEqual(transposedShape.shape.points, [
  [100, 10],
  [200, 20],
  [300, 30],
  [360, 30],
  [250, 20],
  [140, 10],
]);

console.log("confidence-band regression passed");