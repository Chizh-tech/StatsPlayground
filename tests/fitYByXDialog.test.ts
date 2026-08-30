import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assignFitYByXField,
  canCreateFitYByX,
  createFitYByXDialogState,
  filterFitYByXFields,
  type FitYByXFieldInfo,
} from "../src/components/fitYByX/FitYByXRoleDialog.tsx";

const responseField: FitYByXFieldInfo = {
  name: "height",
  sqlType: "DOUBLE",
  modelingRole: "Continuous",
  field: { name: "height", type: "continuous" },
};

const factorField: FitYByXFieldInfo = {
  name: "site",
  sqlType: "VARCHAR",
  modelingRole: "Nominal",
  field: { name: "site", type: "nominal" },
};

const ordinalField: FitYByXFieldInfo = {
  name: "batch",
  sqlType: "VARCHAR",
  modelingRole: "Ordinal",
  field: { name: "batch", type: "ordinal" },
};

let state = createFitYByXDialogState("Fit Y by X 1");
assert.equal(canCreateFitYByX(state), false);

state = assignFitYByXField(state, "response", responseField);
assert.deepEqual(state.response, responseField.field);
assert.equal(state.validationError, null);
assert.equal(canCreateFitYByX(state), false);

const invalidResponse = assignFitYByXField(state, "response", factorField);
assert.deepEqual(invalidResponse.response, responseField.field);
assert.equal(invalidResponse.validationError, "invalidResponse");

state = assignFitYByXField(state, "factor", ordinalField);
assert.deepEqual(state.factor, ordinalField.field);
assert.equal(state.validationError, null);
assert.equal(canCreateFitYByX(state), true);

const duplicateFactor = assignFitYByXField(state, "factor", responseField);
assert.deepEqual(duplicateFactor.factor, ordinalField.field);
assert.equal(duplicateFactor.validationError, "duplicateRole");

const visibleByName = filterFitYByXFields([responseField, factorField, ordinalField], "site");
assert.deepEqual(visibleByName.map(({ name }) => name), ["site"]);

const visibleBySqlType = filterFitYByXFields([responseField, factorField, ordinalField], "double");
assert.deepEqual(visibleBySqlType.map(({ name }) => name), ["height"]);

const visibleByRole = filterFitYByXFields([responseField, factorField, ordinalField], "ordinal");
assert.deepEqual(visibleByRole.map(({ name }) => name), ["batch"]);

const fitYByXViewSource = readFileSync(
  resolve(process.cwd(), "src/components/fitYByX/FitYByXView.tsx"),
  "utf8",
);

assert.equal(
  fitYByXViewSource.includes("useGraphBuilderStore"),
  false,
  "FitYByXView must not import or reference useGraphBuilderStore",
);
assert.equal(
  fitYByXViewSource.includes("fit-y-by-x-graph:${item.id}"),
  true,
  "FitYByXView must materialize an embedded graph id from the Fit Y by X item id",
);
assert.equal(
  fitYByXViewSource.includes("<GraphRuntime") || fitYByXViewSource.includes("GraphRuntime("),
  true,
  "FitYByXView must mount GraphRuntime when the source dataset exists",
);
assert.equal(
  fitYByXViewSource.includes("dataset == null") || fitYByXViewSource.includes("dataset === undefined"),
  true,
  "FitYByXView must guard the missing-source case before mounting GraphRuntime",
);

console.log("fitYByX dialog contract tests passed");