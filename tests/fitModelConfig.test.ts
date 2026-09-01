import assert from "node:assert/strict";

import {
  applyFactorialDegree,
  canonicalInteraction,
  createFitModelItem,
  fitModelParameterCount,
  validateFitModelDefinition,
} from "../src/components/fitModel/fitModelConfig.ts";

const response = { name: "Yield", type: "continuous" as const };
const temperature = { name: "Temperature", type: "continuous" as const };
const pressure = { name: "Pressure", type: "continuous" as const };
const batch = { name: "Batch", type: "nominal" as const };

assert.deepEqual(canonicalInteraction("Temperature", "Pressure"), ["Pressure", "Temperature"]);
assert.deepEqual(applyFactorialDegree([temperature, pressure], 1), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
]);
assert.deepEqual(applyFactorialDegree([temperature, pressure], 2), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
  { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
]);
assert.equal(fitModelParameterCount(applyFactorialDegree([temperature, pressure], 2)), 4);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: applyFactorialDegree([temperature, pressure], 2),
    fields: [response, temperature, pressure],
  }),
  { ok: true },
);

assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [{ kind: "interaction", columnNames: ["Pressure", "Temperature"] }],
  }),
  { ok: false, reason: "missingMainEffect", columnName: "Pressure" },
);

assert.deepEqual(
  validateFitModelDefinition({ response: null, terms: [{ kind: "main", columnNames: ["Temperature"] }] }),
  { ok: false, reason: "missingResponse" },
);
assert.deepEqual(validateFitModelDefinition({ response, terms: [] }), {
  ok: false,
  reason: "missingTerms",
});
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [{ kind: "main", columnNames: ["Yield"] }],
  }),
  { ok: false, reason: "responseInModel", columnName: "Yield" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response: { name: "Batch", type: "nominal" },
    terms: [{ kind: "main", columnNames: ["Temperature"] }],
  }),
  { ok: false, reason: "nonContinuousResponse", columnName: "Batch" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [{ kind: "main", columnNames: ["Batch"] }],
    fields: [response, temperature, pressure, batch],
  }),
  { ok: false, reason: "nonContinuousPredictor", columnName: "Batch" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [
      { kind: "main", columnNames: ["Temperature"] },
      { kind: "main", columnNames: ["Temperature"] },
    ],
  }),
  { ok: false, reason: "duplicateTerm", termKey: "main:Temperature" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [{ kind: "main", columnNames: ["Temperature", "Pressure"] }],
  }),
  { ok: false, reason: "invalidTermArity", termKind: "main" },
);
assert.deepEqual(
  validateFitModelDefinition({
    response,
    terms: [{ kind: "interaction", columnNames: ["Temperature", "Temperature"] }],
  }),
  { ok: false, reason: "sameColumnInteraction", columnName: "Temperature" },
);

const item = createFitModelItem({
  id: "fit-model-1",
  name: "Fit Model 1",
  sourceDatasetId: "dataset-1",
  response,
  terms: applyFactorialDegree([temperature, pressure], 2),
  centeringMethod: "mean",
  createdAt: "2026-09-01T00:00:00.000Z",
});
assert.equal(item.centeringMethod, "mean");

console.log("fitModelConfig contract tests passed");