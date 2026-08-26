import assert from "node:assert/strict";

import { useDistributionStore } from "../src/stores/useDistributionStore.ts";
import type {
  DistributionAnalysisConfigV1,
  DistributionResultEnvelopeV1,
  DistributionRunStateV1,
  LoadedDistributionDocV1,
} from "../src/types/distribution.ts";

const config = (datasetId = "dataset-1"): DistributionAnalysisConfigV1 => ({
  schemaVersion: "1",
  sourceDatasetId: datasetId,
  yColumns: [{ columnId: "col-y", modelingType: "continuous" }],
  weightColumnId: null,
  frequencyColumnId: null,
  byColumnIds: [],
  filterExpr: { kind: "isNull", fieldId: "col-y", negate: true },
  confidenceLevel: 0.95,
  histogramsOnly: false,
  enabledCapabilityIds: [],
  capabilityOverrides: [],
});

useDistributionStore.getState().reset();
const first = useDistributionStore.getState().createItem(config());
const second = useDistributionStore.getState().createItem(config());
assert.equal(first.name, "Distribution 1");
assert.equal(second.name, "Distribution 2");
assert.equal(first.configRevision, 1);
assert.notEqual(first.analysisId, second.analysisId);

const copied = useDistributionStore.getState().copyItem(first.analysisId);
assert.ok(copied);
assert.equal(copied.name, "Distribution 3");
assert.equal(copied.configRevision, 1);
assert.deepEqual(copied.currentConfig, first.currentConfig);
assert.notEqual(copied.analysisId, first.analysisId);

useDistributionStore.getState().renameItem(first.analysisId, "Revenue Distribution");
assert.equal(
  useDistributionStore.getState().items.find((item) => item.analysisId === first.analysisId)?.name,
  "Revenue Distribution",
);

const committed = useDistributionStore.getState().commitConfig(
  first.analysisId,
  1,
  { ...config(), confidenceLevel: 0.99 },
);
assert.deepEqual(committed, { ok: true, configRevision: 2 });
assert.deepEqual(
  useDistributionStore.getState().commitConfig(first.analysisId, 1, config()),
  { ok: false, code: "distribution.config.revisionConflict" },
);

const run: DistributionRunStateV1 = {
  analysisId: first.analysisId,
  configRevision: 2,
  runId: "run-1",
  status: "running",
  progress: null,
  snapshotId: "snapshot-1",
  cancelToken: "cancel-1",
};
assert.equal(useDistributionStore.getState().beginRun(run), true);

const result: DistributionResultEnvelopeV1 = {
  analysisId: first.analysisId,
  configRevision: 2,
  runId: "run-1",
  snapshotId: "snapshot-1",
  completedAt: "2026-08-26T00:00:00Z",
  reportBlocks: [],
};
assert.equal(useDistributionStore.getState().acceptResult(result), true);
assert.deepEqual(useDistributionStore.getState().resultByAnalysisId[first.analysisId], result);
assert.equal(
  useDistributionStore.getState().runStateByAnalysisId[first.analysisId]?.status,
  "completed",
);

const nextRun = { ...run, runId: "run-2", snapshotId: "snapshot-2", status: "running" as const };
assert.equal(useDistributionStore.getState().beginRun(nextRun), true);
assert.equal(useDistributionStore.getState().acceptResult(result), false);
assert.deepEqual(useDistributionStore.getState().resultByAnalysisId[first.analysisId], result);

assert.deepEqual(
  useDistributionStore.getState().commitConfig(first.analysisId, 2, config()),
  { ok: true, configRevision: 3 },
);
assert.equal(
  useDistributionStore.getState().acceptResult({
    ...result,
    runId: "run-2",
    snapshotId: "snapshot-2",
  }),
  false,
);

const failedRun = {
  ...run,
  configRevision: 3,
  runId: "run-3",
  snapshotId: "snapshot-3",
  status: "running" as const,
};
assert.equal(useDistributionStore.getState().beginRun(failedRun), true);
assert.equal(useDistributionStore.getState().failRun({
  analysisId: first.analysisId,
  configRevision: 3,
  runId: "run-3",
  snapshotId: "snapshot-3",
  code: "distribution.run.syntheticFailure",
  messageKey: "distribution.errors.syntheticFailure",
}), true);
assert.equal(useDistributionStore.getState().failureByAnalysisId[first.analysisId]?.code,
  "distribution.run.syntheticFailure");
assert.deepEqual(useDistributionStore.getState().resultByAnalysisId[first.analysisId], result);

useDistributionStore.getState().selectItem(first.analysisId);
useDistributionStore.getState().deleteItem(first.analysisId);
assert.equal(useDistributionStore.getState().selectedAnalysisId, null);
assert.equal(useDistributionStore.getState().runStateByAnalysisId[first.analysisId], undefined);
assert.equal(useDistributionStore.getState().resultByAnalysisId[first.analysisId], undefined);

const loaded: LoadedDistributionDocV1 = {
  schemaVersion: "1",
  analysisId: "loaded-8",
  name: "Distribution 8",
  sourceDatasetId: "dataset-1",
  status: "ready",
  loadStatus: "ready",
  configRevision: 4,
  currentConfig: config(),
};
useDistributionStore.getState().loadFromProject([loaded], [], []);
assert.deepEqual(useDistributionStore.getState().runStateByAnalysisId, {});
assert.deepEqual(useDistributionStore.getState().resultByAnalysisId, {});
assert.equal(useDistributionStore.getState().createItem(config()).name, "Distribution 9");

useDistributionStore.getState().reset();
console.log("distribution lifecycle store OK");