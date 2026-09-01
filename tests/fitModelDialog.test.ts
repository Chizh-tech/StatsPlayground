import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import type { FieldRef } from "../src/graphCore/types.ts";
import type { FitModelCenteringMethod } from "../src/types/fitModel.ts";
import {
  beginFitModelFieldLoad,
  FIT_MODEL_DIALOG_FIELD_DRAG_MIME,
  assignFitModelResponse,
  canCreateFitModel,
  createAssignResponseAction,
  createFitModelDropAction,
  createFitModelDraft,
  createFitModelFieldLoadSnapshot,
  createToggleInteractionAction,
  createToggleMainEffectAction,
  filterFitModelFields,
  hasFitModelDragType,
  parseFitModelDragPayload,
  reduceFitModelDraft,
  resolveFitModelFieldLoadError,
  resolveFitModelFieldLoadSuccess,
  termsFromDraft,
  toFitModelFieldInfo,
  type FitModelDraft,
  type FitModelFieldInfo,
} from "../src/components/fitModel/fitModelDialogState.ts";

const fitModelBarrelSource = readFileSync(
  resolve(process.cwd(), "src/components/fitModel/index.ts"),
  "utf8",
);

assert.equal(
  fitModelBarrelSource.includes("FitModelRoleDialog") && fitModelBarrelSource.includes("./FitModelRoleDialog"),
  true,
  "Fit Model barrel must export FitModelRoleDialog",
);
assert.equal(
  fitModelBarrelSource.includes("fitModelDialogState")
    && fitModelBarrelSource.includes("createFitModelDraft")
    && fitModelBarrelSource.includes("canCreateFitModel"),
  true,
  "Fit Model barrel must export dialog-state helpers",
);

assert.equal(FIT_MODEL_DIALOG_FIELD_DRAG_MIME, "application/x-statsplayground-fit-model-field");
assert.equal(hasFitModelDragType(["text/plain", FIT_MODEL_DIALOG_FIELD_DRAG_MIME]), true);
assert.equal(hasFitModelDragType(["text/plain"]), false);
assert.deepEqual(parseFitModelDragPayload(""), null);
assert.deepEqual(parseFitModelDragPayload("{\"fieldName\":\"Temperature\"}"), { fieldName: "Temperature" });
assert.deepEqual(parseFitModelDragPayload("{\"fieldName\":42}"), null);

const response: FitModelFieldInfo = {
  name: "Yield",
  sqlType: "DOUBLE",
  modelingRole: "Continuous",
  field: { name: "Yield", type: "continuous" },
};
const temperature: FitModelFieldInfo = {
  name: "Temperature",
  sqlType: "DOUBLE",
  modelingRole: "Continuous",
  field: { name: "Temperature", type: "continuous" },
};
const pressure: FitModelFieldInfo = {
  name: "Pressure",
  sqlType: "DOUBLE",
  modelingRole: "Continuous",
  field: { name: "Pressure", type: "continuous" },
};
const nominalField: FitModelFieldInfo = {
  name: "Batch",
  sqlType: "VARCHAR",
  modelingRole: "Nominal",
  field: { name: "Batch", type: "nominal" },
};
const ordinalField: FitModelFieldInfo = {
  name: "Lot",
  sqlType: "VARCHAR",
  modelingRole: "Ordinal",
  field: { name: "Lot", type: "ordinal" },
};
const datetimeField: FitModelFieldInfo = {
  name: "CollectedAt",
  sqlType: "TIMESTAMP",
  modelingRole: "Datetime",
  field: { name: "CollectedAt", type: "datetime" },
};
const idField: FitModelFieldInfo = {
  name: "RowId",
  sqlType: "BIGINT",
  modelingRole: "Id",
  field: { name: "RowId", type: "id" },
};

const visibleByName = filterFitModelFields([response, temperature, pressure], "press");
assert.deepEqual(visibleByName.map((field) => field.name), ["Pressure"]);

const visibleBySqlType = filterFitModelFields([response, temperature, pressure], "double");
assert.deepEqual(visibleBySqlType.map((field) => field.name), ["Yield", "Temperature", "Pressure"]);

const visibleByRole = filterFitModelFields([response, nominalField, ordinalField], "ordinal");
assert.deepEqual(visibleByRole.map((field) => field.name), ["Lot"]);

const fieldsByName = new Map<string, FitModelFieldInfo>([
  [response.name, response],
  [temperature.name, temperature],
  [pressure.name, pressure],
]);
assert.deepEqual(
  createFitModelDropAction("response", { fieldName: response.name }, fieldsByName),
  createAssignResponseAction(response),
);
assert.deepEqual(
  createFitModelDropAction("mainEffects", { fieldName: temperature.name }, fieldsByName),
  createToggleMainEffectAction(temperature),
);
assert.equal(createFitModelDropAction("response", { fieldName: "Unknown" }, fieldsByName), null);

let draft = createFitModelDraft();
assert.deepEqual(draft, {
  response: null,
  mainEffects: [],
  interactions: [],
  centeringMethod: "none",
  validationMessage: null,
});
assert.equal(canCreateFitModel(draft), false);

const nonContinuousResponse = assignFitModelResponse(draft, nominalField);
assert.equal(nonContinuousResponse.response, null);
assert.equal(nonContinuousResponse.validationMessage?.code, "nonContinuousField");

draft = assignFitModelResponse(draft, response);
assert.deepEqual(draft.response, response.field);

const addNominalMain = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: nominalField,
});
assert.equal(addNominalMain.mainEffects.length, 0);
assert.equal(addNominalMain.validationMessage?.code, "nonContinuousField");

const addOrdinalMain = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: ordinalField,
});
assert.equal(addOrdinalMain.mainEffects.length, 0);
assert.equal(addOrdinalMain.validationMessage?.code, "nonContinuousField");

const addDatetimeMain = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: datetimeField,
});
assert.equal(addDatetimeMain.mainEffects.length, 0);
assert.equal(addDatetimeMain.validationMessage?.code, "nonContinuousField");

const addIdMain = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: idField,
});
assert.equal(addIdMain.mainEffects.length, 0);
assert.equal(addIdMain.validationMessage?.code, "nonContinuousField");

draft = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: temperature,
});
assert.deepEqual(draft.mainEffects, [temperature.field]);

const responseCollision = assignFitModelResponse(draft, temperature);
assert.equal(responseCollision.response?.name, "Yield");
assert.equal(responseCollision.validationMessage?.code, "responseCollision");

draft = reduceFitModelDraft(draft, {
  type: "toggleMainEffect",
  field: pressure,
});
assert.deepEqual(draft.mainEffects.map((field) => field.name), ["Temperature", "Pressure"]);

draft = reduceFitModelDraft(draft, {
  type: "addInteraction",
  leftName: "Temperature",
  rightName: "Pressure",
});
assert.deepEqual(draft.interactions, [["Pressure", "Temperature"]]);

const toggleRemoveAction = createToggleInteractionAction(draft, "Temperature", "Pressure");
assert.deepEqual(toggleRemoveAction, {
  type: "removeInteraction",
  leftName: "Pressure",
  rightName: "Temperature",
});
draft = reduceFitModelDraft(draft, toggleRemoveAction);
assert.deepEqual(draft.interactions, []);

const toggleAddAction = createToggleInteractionAction(draft, "Temperature", "Pressure");
assert.deepEqual(toggleAddAction, {
  type: "addInteraction",
  leftName: "Pressure",
  rightName: "Temperature",
});
draft = reduceFitModelDraft(draft, toggleAddAction);
assert.deepEqual(draft.interactions, [["Pressure", "Temperature"]]);

const withCentering = reduceFitModelDraft(draft, {
  type: "setCenteringMethod",
  centeringMethod: "mean",
});
assert.equal(withCentering.centeringMethod, "mean");

const blockedMainRemoval = reduceFitModelDraft(withCentering, {
  type: "toggleMainEffect",
  field: temperature,
});
assert.equal(blockedMainRemoval.validationMessage?.code, "mainRequiredByInteraction");
assert.deepEqual(blockedMainRemoval.validationMessage?.interactionLabels, ["Pressure*Temperature"]);

const removedInteraction = reduceFitModelDraft(withCentering, {
  type: "removeInteraction",
  leftName: "Pressure",
  rightName: "Temperature",
});
assert.deepEqual(removedInteraction.interactions, []);
assert.equal(removedInteraction.centeringMethod, "none");

const removeMain = reduceFitModelDraft(removedInteraction, {
  type: "toggleMainEffect",
  field: temperature,
});
assert.deepEqual(removeMain.mainEffects.map((field) => field.name), ["Pressure"]);

const blockedLastMain = reduceFitModelDraft(removeMain, {
  type: "toggleMainEffect",
  field: pressure,
});
assert.equal(blockedLastMain.validationMessage?.code, "lastMainEffect");
assert.deepEqual(blockedLastMain.mainEffects.map((field) => field.name), ["Pressure"]);

const macroSeed = reduceFitModelDraft(
  reduceFitModelDraft(
    reduceFitModelDraft(assignFitModelResponse(createFitModelDraft(), response), {
      type: "toggleMainEffect",
      field: temperature,
    }),
    {
      type: "toggleMainEffect",
      field: pressure,
    },
  ),
  {
    type: "addInteraction",
    leftName: "Temperature",
    rightName: "Pressure",
  },
);
const macroSeedWithCentering = reduceFitModelDraft(macroSeed, {
  type: "setCenteringMethod",
  centeringMethod: "mean",
});

const allFields: readonly FieldRef[] = [
  response.field,
  temperature.field,
  pressure.field,
  nominalField.field,
  ordinalField.field,
  datetimeField.field,
  idField.field,
];

const degreeOne = reduceFitModelDraft(macroSeedWithCentering, {
  type: "applyDegree",
  degree: 1,
  fields: allFields,
});
assert.equal(degreeOne.response?.name, "Yield");
assert.equal(degreeOne.centeringMethod, "mean");
assert.deepEqual(termsFromDraft(degreeOne), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
]);

const degreeTwo = reduceFitModelDraft(macroSeedWithCentering, {
  type: "applyDegree",
  degree: 2,
  fields: allFields,
});
assert.equal(degreeTwo.response?.name, "Yield");
assert.equal(degreeTwo.centeringMethod, "mean");
assert.deepEqual(termsFromDraft(degreeTwo), [
  { kind: "main", columnNames: ["Temperature"] },
  { kind: "main", columnNames: ["Pressure"] },
  { kind: "interaction", columnNames: ["Pressure", "Temperature"] },
]);

const invalidCentering = reduceFitModelDraft(degreeOne, {
  type: "setCenteringMethod",
  centeringMethod: "mean",
});
assert.equal(invalidCentering.centeringMethod, "none");

const validDraft = degreeTwo;
assert.equal(canCreateFitModel(validDraft), true);

const invalidHierarchy: FitModelDraft = {
  response: response.field,
  mainEffects: [{ name: "Temperature", type: "continuous" }],
  interactions: [["Pressure", "Temperature"]],
  centeringMethod: "mean" satisfies FitModelCenteringMethod,
  validationMessage: null,
};
assert.equal(canCreateFitModel(invalidHierarchy), false);

const fitModelRoleDialogSource = readFileSync(
  resolve(process.cwd(), "src/components/fitModel/FitModelRoleDialog.tsx"),
  "utf8",
);

assert.equal(
  fitModelRoleDialogSource.includes("role=\"dialog\"")
    && fitModelRoleDialogSource.includes("aria-modal=\"true\""),
  true,
  "FitModelRoleDialog must use dialog semantics",
);
assert.equal(
  fitModelRoleDialogSource.includes("aria-describedby"),
  true,
  "FitModelRoleDialog must bind validation copy through aria-describedby",
);
assert.equal(
  fitModelRoleDialogSource.includes("onDragOver")
    && fitModelRoleDialogSource.includes("onDrop")
    && fitModelRoleDialogSource.includes("aria-pressed")
    && fitModelRoleDialogSource.includes("common.retry"),
  true,
  "FitModelRoleDialog must keep structural drag/drop zones, pressed-state interactions, and retry affordance",
);
assert.equal(
  fitModelRoleDialogSource.includes("Create") && fitModelRoleDialogSource.includes("Cancel"),
  true,
  "FitModelRoleDialog must keep Create and Cancel actions",
);
assert.equal(
  fitModelRoleDialogSource.includes("event.key.toLowerCase()")
    && fitModelRoleDialogSource.includes("key === \"y\"")
    && fitModelRoleDialogSource.includes("key === \"m\""),
  true,
  "FitModelRoleDialog must keep keyboard assignment shortcuts",
);
assert.equal(
  fitModelRoleDialogSource.includes("aria-label={t(\"fitModel.dialog.assignResponseLabel\"")
    && fitModelRoleDialogSource.includes("aria-label={t(\"fitModel.dialog.assignMainLabel\"")
    && fitModelRoleDialogSource.includes("aria-label={t(\"fitModel.dialog.toggleInteraction\""),
  true,
  "FitModelRoleDialog must keep localized accessibility labels for role assignment and interaction toggle",
);

const baseLoad = createFitModelFieldLoadSnapshot();
assert.deepEqual(baseLoad, {
  generation: 0,
  loading: false,
  error: null,
  fields: [],
});

const firstLoad = beginFitModelFieldLoad(baseLoad);
assert.equal(firstLoad.generation, 1);
assert.equal(firstLoad.loading, true);
assert.equal(firstLoad.error, null);

const retryLoad = beginFitModelFieldLoad(firstLoad);
assert.equal(retryLoad.generation, 2);
assert.equal(retryLoad.loading, true);
assert.equal(retryLoad.error, null);

const staleCompletion = resolveFitModelFieldLoadSuccess(
  retryLoad,
  1,
  [temperature],
);
assert.deepEqual(staleCompletion, retryLoad);

const currentCompletion = resolveFitModelFieldLoadSuccess(
  staleCompletion,
  2,
  [pressure],
);
assert.equal(currentCompletion.loading, false);
assert.equal(currentCompletion.error, null);
assert.deepEqual(currentCompletion.fields.map((field) => field.name), ["Pressure"]);

const failedRetry = beginFitModelFieldLoad(currentCompletion);
const staleFailure = resolveFitModelFieldLoadError(failedRetry, 2, new Error("stale"));
assert.deepEqual(staleFailure, failedRetry);
const currentFailure = resolveFitModelFieldLoadError(failedRetry, 3, new Error("retry failed"));
assert.equal(currentFailure.loading, false);
assert.equal(currentFailure.error, "Error: retry failed");
assert.deepEqual(currentFailure.fields, []);

const continuousColumn = toFitModelFieldInfo("temperature", "DOUBLE");
assert.deepEqual(continuousColumn, {
  name: "temperature",
  sqlType: "DOUBLE",
  modelingRole: "Continuous",
  field: { name: "temperature", type: "continuous" },
});

const ordinalColumn = toFitModelFieldInfo("lot", "DOUBLE", { extras: { valueOrder: { values: ["1", "2"] } } });
assert.equal(ordinalColumn.field.type, "ordinal");
assert.equal(ordinalColumn.modelingRole, "Ordinal");

console.log("fitModel dialog contract tests passed");
