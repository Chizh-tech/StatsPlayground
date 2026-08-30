import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import {
  assignFitYByXField,
  canCreateFitYByX,
  createFitYByXDialogState,
  filterFitYByXFields,
  type FitYByXFieldInfo,
} from "../src/components/fitYByX/index.ts";

const fitYByXBarrelSource = readFileSync(
  resolve(process.cwd(), "src/components/fitYByX/index.ts"),
  "utf8",
);

assert.equal(
  fitYByXBarrelSource.includes("FitYByXRoleDialog") && fitYByXBarrelSource.includes("./FitYByXRoleDialog"),
  true,
  "Fit Y by X barrel must keep exporting FitYByXRoleDialog",
);
assert.equal(
  fitYByXBarrelSource.includes("FitYByXRoleZone") && fitYByXBarrelSource.includes("./FitYByXRoleZone"),
  true,
  "Fit Y by X barrel must keep exporting FitYByXRoleZone",
);
assert.equal(
  fitYByXBarrelSource.includes("FitYByXView") && fitYByXBarrelSource.includes("./FitYByXView"),
  true,
  "Fit Y by X barrel must keep exporting FitYByXView",
);
assert.equal(
  fitYByXBarrelSource.includes("createDefaultFitYByXGraphConfig")
    && fitYByXBarrelSource.includes("createFitYByXItem")
    && fitYByXBarrelSource.includes("./fitYByXConfig"),
  true,
  "Fit Y by X barrel must keep exporting the public config helpers",
);
assert.equal(
  fitYByXBarrelSource.includes("FitYByXFieldInfo")
    && fitYByXBarrelSource.includes("createFitYByXDialogState")
    && fitYByXBarrelSource.includes("filterFitYByXFields"),
  true,
  "Fit Y by X barrel must keep exporting the public dialog-state and search helpers",
);

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
  fitYByXViewSource.includes("workspace.datasourceDeleted"),
  true,
  "FitYByXView must use the workspace unavailable-document presentation when the source dataset is missing",
);
assert.equal(
  fitYByXViewSource.includes("{item.name}"),
  true,
  "FitYByXView must preserve the analysis header when the source dataset is missing",
);
assert.equal(
  fitYByXViewSource.includes("dataset ?") && fitYByXViewSource.includes("workspace.datasourceLabel") && fitYByXViewSource.includes("workspace.datasourceDeleted"),
  true,
  "FitYByXView must preserve the source slot and switch it to the deleted-source label when the dataset is missing",
);
assert.equal(
  fitYByXViewSource.includes("item.response.name") && fitYByXViewSource.includes("item.factor.name"),
  true,
  "FitYByXView must preserve response and factor summary context when the dataset is missing",
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
assert.equal(
  fitYByXViewSource.includes("dataset == null ? (") || fitYByXViewSource.includes("dataset === undefined ? ("),
  true,
  "FitYByXView must render the unavailable state inline instead of returning early before the surrounding analysis context",
);

console.log("fitYByX dialog contract tests passed");