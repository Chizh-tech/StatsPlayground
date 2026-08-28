import assert from "node:assert/strict";

import {
  createDefaultGraph2DState,
  createDefaultGraph3DState,
  createDefaultMultivariateGraphState,
  normalizeGraphBuilderItem,
} from "../src/components/graphBuilder/graphBuilderMode.ts";
import { getLayerMode } from "../src/components/graphBuilder/graphLayerConfig.ts";

import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";

const continuous = (name: string) => ({ name, type: "continuous" as const });
const nominal = (name: string) => ({ name, type: "nominal" as const });

const legacyBase = {
  id: "legacy-1",
  name: "Legacy",
  sourceDatasetId: "dataset-1",
  encoding: {
    x: continuous("x"),
    y: continuous("y"),
    z: continuous("z"),
    color: nominal("color"),
    groupX: nominal("gx"),
    groupY: nominal("gy"),
    groupZ: nominal("gz"),
    overlay: nominal("ov"),
    wrap: nominal("wrap"),
  },
  multiX: [continuous("mx0")],
  multiY: [continuous("my0")],
  elements: [
    { kind: "points", enabled: true },
    { kind: "surface", enabled: true },
    { kind: "line", enabled: true },
  ],
  smootherLambda: 0.42,
  groupStyles: { alpha: { line: { color: "#123" } } },
  hiddenGroups: ["alpha"],
  refLinesY: [{ y: 1, label: "Y1" }],
  refLinesX: [{ x: 2, label: "X2" }],
  autoSpecLines: true,
  autoSpecLinesY: false,
  autoSpecLinesX: true,
  yAxis: { min: 0, max: 10 },
  xAxis: { min: -1, max: 5 },
  createdAt: "2026-01-01T00:00:00.000Z",
} as const;

assert.deepEqual(createDefaultMultivariateGraphState(), {
  columns: [],
  chartType: "correlationMatrix",
  correlationMethod: "pearson",
});

assert.equal(createDefaultGraph2DState().elements.length > 0, true);
assert.equal(createDefaultGraph2DState().elements[0]?.kind, "points");
assert.equal(createDefaultGraph3DState().elements.length > 0, true);
assert.equal(createDefaultGraph3DState().elements[0]?.kind, "scatter3d");

assert.equal(getLayerMode("points"), "2d");
assert.equal(getLayerMode("surface"), "3d");
assert.equal(getLayerMode("correlationMatrix"), "multivariate");

const legacy2d = normalizeGraphBuilderItem({
  ...legacyBase,
  threeD: false,
});
assert.equal(legacy2d.mode, "2d");
assert.deepEqual(legacy2d.modeStates.twoD.encoding.x, legacyBase.encoding.x);
assert.deepEqual(legacy2d.modeStates.twoD.encoding.y, legacyBase.encoding.y);
assert.deepEqual(legacy2d.modeStates.threeD.encoding.x, legacyBase.encoding.x);
assert.deepEqual(legacy2d.modeStates.threeD.encoding.y, legacyBase.encoding.y);
assert.deepEqual(legacy2d.modeStates.threeD.encoding.z, legacyBase.encoding.z);
assert.deepEqual(legacy2d.modeStates.twoD.elements.map((element) => element.kind), ["points", "line"]);
assert.deepEqual(legacy2d.modeStates.threeD.elements.map((element) => element.kind), ["surface"]);

const legacy3d = normalizeGraphBuilderItem({
  ...legacyBase,
  threeD: true,
});
assert.equal(legacy3d.mode, "3d");

const legacyCorrelation = normalizeGraphBuilderItem({
  ...legacyBase,
  multiX: [continuous("a"), continuous("b")],
  multiY: [continuous("ignored"), continuous("alsoIgnored")],
  elements: [{ kind: "correlationMatrix", correlationMethod: "spearman" }],
});
assert.equal(legacyCorrelation.mode, "multivariate");
assert.deepEqual(
  legacyCorrelation.modeStates.multivariate.columns.map((field) => field.name),
  ["a", "b"],
);
assert.equal(legacyCorrelation.modeStates.multivariate.correlationMethod, "spearman");

const legacyCorrelationInvalidMethod = normalizeGraphBuilderItem({
  ...legacyBase,
  multiX: [continuous("a"), continuous("b")],
  elements: [{ kind: "correlationMatrix", correlationMethod: "distance" }],
});
assert.equal(legacyCorrelationInvalidMethod.modeStates.multivariate.correlationMethod, "pearson");

const idempotenceCases: GraphBuilderItem[] = [legacy2d, legacy3d, legacyCorrelation];
for (const item of idempotenceCases) {
  assert.deepEqual(normalizeGraphBuilderItem(item), item);
}

console.log("graphBuilderMode migration tests passed");