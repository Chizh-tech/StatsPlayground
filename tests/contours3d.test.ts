import assert from "node:assert/strict";
import { buildContourPolylines } from "../src/graphCore/contours3d.ts";

const lines = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([0, 1, 1, 2]),
  zmin: 0,
  zmax: 2,
}, 3);

assert.deepEqual(lines.find((line) => line.level === 1), {
  level: 1,
  points: [[1, 0, 1], [0, 1, 1]],
});
assert.deepEqual([...new Set(lines.map((line) => line.level))], [0.5, 1, 1.5]);

const holeLines = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([0, Number.NaN, 1, 2]),
  zmin: 0,
  zmax: 2,
}, 3);
assert.deepEqual(holeLines, []);

const flatLines = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([1, 1, 1, 1]),
  zmin: 1,
  zmax: 1,
}, 3);
assert.deepEqual(flatLines, []);

const stitched = buildContourPolylines({
  xs: [0, 1, 2],
  ys: [0, 1],
  values: new Float64Array([0, 1, 2, 1, 2, 3]),
  zmin: 0,
  zmax: 3,
}, 3);
assert.deepEqual(stitched.find((line) => line.level === 1.5), {
  level: 1.5,
  points: [[0.5, 1, 1.5], [1, 0.5, 1.5], [1.5, 0, 1.5]],
});

const saddleA = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([1, 0, 0, 1]),
  zmin: 0,
  zmax: 1,
}, 3);
const saddleB = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([1, 0, 0, 1]),
  zmin: 0,
  zmax: 1,
}, 3);
assert.deepEqual(saddleA, saddleB);
assert.ok(saddleA.every((line) => line.points.every((point) => point.every(Number.isFinite))));

const clamped = buildContourPolylines({
  xs: [0, 1],
  ys: [0, 1],
  values: new Float64Array([0, 1, 1, 2]),
  zmin: 0,
  zmax: 2,
}, 99);
assert.equal([...new Set(clamped.map((line) => line.level))].length, 20);
assert.ok(clamped.every((line) => Number.isFinite(line.level)));

console.log("contours3d regressions passed");