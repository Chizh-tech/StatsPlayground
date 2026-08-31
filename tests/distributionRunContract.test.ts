import assert from "node:assert/strict";

import type {
  DistributionCancelTokenV1,
  DistributionContinuousFitConfigV1,
  DistributionProgressV1,
  DistributionRequestV1,
  DistributionResultEnvelopeV1,
  DistributionRunAcceptedV1,
  DistributionRunFailureV1,
} from "../src/types/distribution.ts";

const request: DistributionRequestV1 = {
  schemaVersion: "1",
  analysisId: "analysis-1",
  configRevision: 3,
  sourceDatasetId: "dataset-1",
  sourceDataVersion: null,
  mode: "continuous",
  yColumns: [{ columnId: "value", modelingType: "continuous" }],
  weightColumnId: null,
  frequencyColumnId: null,
  byColumnIds: [],
  filterExpr: { kind: "and", exprs: [] },
  confidenceLevel: 0.95,
  histogramsOnly: false,
  continuousFit: {
    enabledDistributionIds: ["normal", "gamma"],
    fitAll: false,
    diagnostics: {
      goodnessOfFit: false,
      qqPlot: false,
      cdfPlot: false,
      ppPlot: false,
    },
  } satisfies DistributionContinuousFitConfigV1,
  enabledCapabilityIds: [],
  capabilityOverrides: [],
  observationPolicy: { schemaVersion: "1", dimensions: [] },
  resourceBudget: {
    maxGroups: 1_000,
    maxRowsPerGroup: 100_000,
    maxTotalRows: 1_000_000,
    maxTotalBytes: 64 * 1024 * 1024,
    cancelToken: null,
  },
  exact: true,
};

const histogramsOnlyRequest: DistributionRequestV1 = {
  ...request,
  histogramsOnly: true,
};
assert.equal(histogramsOnlyRequest.histogramsOnly, true);

const accepted: DistributionRunAcceptedV1 = {
  analysisId: "analysis-1",
  configRevision: 3,
  runId: "run-server-1",
  snapshotId: "snapshot-server-1",
  cancelToken: "cancel-server-1",
};

const progress: DistributionProgressV1 = {
  analysisId: accepted.analysisId,
  configRevision: accepted.configRevision,
  runId: accepted.runId,
  snapshotId: accepted.snapshotId,
  phase: "distribution.run.accepted",
  current: 0,
  total: 1,
  messageKey: "distribution.run.accepted",
  percent: 0,
};

assert.deepEqual(
  [progress.analysisId, progress.configRevision, progress.runId, progress.snapshotId],
  [accepted.analysisId, accepted.configRevision, accepted.runId, accepted.snapshotId],
);

const completed: DistributionResultEnvelopeV1 = {
  analysisId: accepted.analysisId,
  configRevision: accepted.configRevision,
  runId: accepted.runId,
  snapshotId: accepted.snapshotId,
  completedAt: "2026-08-26T00:00:00Z",
  reportBlocks: [],
};
const failed: DistributionRunFailureV1 = {
  analysisId: accepted.analysisId,
  configRevision: accepted.configRevision,
  runId: accepted.runId,
  snapshotId: accepted.snapshotId,
  code: "distribution.run.failed",
  messageKey: "distribution.run.failed",
};
for (const envelope of [completed, failed]) {
  assert.deepEqual(
    [envelope.analysisId, envelope.configRevision, envelope.runId, envelope.snapshotId],
    [accepted.analysisId, accepted.configRevision, accepted.runId, accepted.snapshotId],
  );
}

const invokeCalls: Array<{ command: string; args: unknown }> = [];
Object.assign(globalThis, {
  window: {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown = {}) => {
        invokeCalls.push({ command, args });
        if (command === "start_distribution_run") return accepted;
        return undefined;
      },
    },
  },
});

const { distributionService } = await import("../src/services/distributionService.ts");
assert.deepEqual(await distributionService.startRun(request), accepted);
assert.deepEqual(await distributionService.startRun(histogramsOnlyRequest), accepted);

const token: DistributionCancelTokenV1 = { cancelToken: accepted.cancelToken };
await distributionService.cancelRun(token);

assert.deepEqual(invokeCalls, [
  { command: "start_distribution_run", args: { request } },
  { command: "start_distribution_run", args: { request: histogramsOnlyRequest } },
  { command: "cancel_distribution_run", args: { token } },
]);
assert.deepEqual(
  invokeCalls[0]?.args,
  { request },
);
assert.deepEqual(
  (invokeCalls[0]?.args as { request: DistributionRequestV1 }).request.continuousFit,
  request.continuousFit,
);

console.log("distribution run contract OK");