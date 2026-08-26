import assert from "node:assert/strict";

import {
  createCapabilityOverrideRegistry,
  validateDistributionConfig,
} from "../src/components/distribution/distributionConfig.ts";
import type {
  CapabilityOverrideEnvelopeV1,
  DistributionAnalysisConfigV1,
  DistributionColumnInfoV1,
} from "../src/types/distribution.ts";

const columns: DistributionColumnInfoV1[] = [
  {
    columnId: "col-y",
    sqlType: "DOUBLE",
    modelingType: "continuous",
    integerCompatible: false,
  },
  {
    columnId: "col-weight",
    sqlType: "DOUBLE",
    modelingType: "continuous",
    integerCompatible: false,
  },
  {
    columnId: "col-freq",
    sqlType: "INTEGER",
    modelingType: "discreteNumeric",
    integerCompatible: true,
  },
  {
    columnId: "col-group",
    sqlType: "VARCHAR",
    modelingType: "nominal",
    integerCompatible: false,
  },
  {
    columnId: "col-date",
    sqlType: "TIMESTAMP",
    modelingType: "datetime",
    integerCompatible: false,
  },
];

const config: DistributionAnalysisConfigV1 = {
  schemaVersion: "1",
  sourceDatasetId: "dataset-1",
  yColumns: [{ columnId: "col-y", modelingType: "continuous" }],
  weightColumnId: "col-weight",
  frequencyColumnId: "col-freq",
  byColumnIds: ["col-group", "col-date"],
  filterExpr: { kind: "isNull", fieldId: "col-group", negate: true },
  confidenceLevel: 0.95,
  histogramsOnly: false,
  enabledCapabilityIds: [],
  capabilityOverrides: [],
};

assert.deepEqual(validateDistributionConfig(config, columns), []);
assert.deepEqual(
  validateDistributionConfig({ ...config, yColumns: [] }, columns)[0],
  {
    code: "distribution.config.yRequired",
    messageKey: "distribution.errors.yRequired",
    fieldPath: "yColumns",
  },
);
assert.equal(
  validateDistributionConfig({ ...config, confidenceLevel: 1 }, columns)[0]?.code,
  "distribution.config.confidenceOutOfRange",
);
assert.equal(
  validateDistributionConfig(
    { ...config, yColumns: [{ columnId: "col-group", modelingType: "nominal" }] },
    columns,
  )[0]?.code,
  "distribution.config.yTypeIncompatible",
);
assert.equal(
  validateDistributionConfig({ ...config, weightColumnId: "col-y" }, columns)[0]?.code,
  "distribution.config.roleConflict",
);
assert.equal(
  validateDistributionConfig(
    { ...config, weightColumnId: null, frequencyColumnId: "col-weight" },
    columns,
  )[0]?.code,
  "distribution.config.freqNotIntegerCompatible",
);

const unknownOverride: CapabilityOverrideEnvelopeV1 = {
  schemaVersion: "1",
  capabilityId: "capability.unknown",
  payloadSchemaVersion: "1",
  payload: {},
};
assert.equal(
  validateDistributionConfig(
    { ...config, capabilityOverrides: [unknownOverride] },
    columns,
  )[0]?.code,
  "distribution.config.unknownCapability",
);

const registry = createCapabilityOverrideRegistry([
  {
    capabilityId: "capability.synthetic",
    payloadSchemaVersion: "1",
    validate: (payload) =>
      typeof payload === "object" && payload !== null && "enabled" in payload
        ? []
        : [{
            code: "distribution.config.payloadValidationFailed",
            messageKey: "distribution.errors.payloadValidationFailed",
            fieldPath: "enabled",
          }],
  },
]);
const validOverride: CapabilityOverrideEnvelopeV1 = {
  schemaVersion: "1",
  capabilityId: "capability.synthetic",
  payloadSchemaVersion: "1",
  payload: { enabled: true },
};
assert.deepEqual(
  validateDistributionConfig(
    {
      ...config,
      enabledCapabilityIds: ["capability.synthetic"],
      capabilityOverrides: [validOverride],
    },
    columns,
    registry,
  ),
  [],
);
assert.equal(
  validateDistributionConfig(
    {
      ...config,
      enabledCapabilityIds: ["capability.synthetic"],
      capabilityOverrides: [{ ...validOverride, payload: {} }],
    },
    columns,
    registry,
  )[0]?.fieldPath,
  "capabilityOverrides[0].payload.enabled",
);
assert.equal(
  validateDistributionConfig(
    {
      ...config,
      enabledCapabilityIds: ["capability.synthetic"],
      capabilityOverrides: [validOverride, validOverride],
    },
    columns,
    registry,
  )[0]?.code,
  "distribution.config.duplicateCapabilityOverride",
);

console.log("distribution configuration contracts OK");