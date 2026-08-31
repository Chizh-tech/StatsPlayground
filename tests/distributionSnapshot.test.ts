import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { useDistributionStore } from "../src/stores/useDistributionStore.ts";
import type { DistributionAnalysisConfigV1 } from "../src/types/distribution.ts";

const typesSource = readFileSync(
  new URL("../src/types/distribution.ts", import.meta.url),
  "utf8",
);
assert.match(typesSource, /interface DistributionProgressV1/);
assert.match(typesSource, /interface DistributionCancelTokenV1/);
assert.match(typesSource, /interface DistributionRunStateV1/);

const config: DistributionAnalysisConfigV1 = {
  schemaVersion: "1",
  sourceDatasetId: "dataset-1",
  yColumns: [{ columnId: "col-y", modelingType: "continuous" }],
  weightColumnId: null,
  frequencyColumnId: null,
  byColumnIds: [],
  filterExpr: { kind: "isNull", fieldId: "col-y", negate: true },
  confidenceLevel: 0.95,
  histogramsOnly: false,
  enabledCapabilityIds: [],
  capabilityOverrides: [],
};
const item = useDistributionStore.getState().createItem(config);

useDistributionStore.getState().startRun({
  analysisId: item.analysisId,
  configRevision: 1,
  runId: "run-1",
  status: "running",
  progress: null,
  snapshotId: "snapshot-1",
  cancelToken: "cancel-1",
});
useDistributionStore.getState().updateProgress({
  analysisId: item.analysisId,
  configRevision: 1,
  runId: "run-1",
  snapshotId: "snapshot-1",
  phase: "prepare",
  current: 4,
  total: 10,
  messageKey: "distribution.prepare",
  percent: 40,
});
useDistributionStore.getState().updateProgress({
  analysisId: item.analysisId,
  configRevision: 1,
  runId: "run-1",
  snapshotId: "snapshot-1",
  phase: "prepare",
  current: 3,
  total: 10,
  messageKey: "distribution.prepare",
  percent: 30,
});
assert.equal(useDistributionStore.getState().runState?.progress?.current, 4);
useDistributionStore.getState().cancelRun("cancel-1");
assert.equal(useDistributionStore.getState().runState?.status, "cancelled");
useDistributionStore.getState().reset();

console.log("distribution snapshot control plane OK");