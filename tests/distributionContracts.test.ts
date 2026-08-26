import assert from "node:assert/strict";

import type {
  BlackBoxCaseV1,
  DistributionChartDataV1,
  DistributionChartKindV1,
  DistributionWorkspaceBootstrapV1,
} from "../src/types/distribution.ts";

const chartKinds = [
  "histogramData",
  "boxPlotData",
  "qqData",
  "ppData",
  "cdfData",
  "fittedCurveData",
  "diagnosticCoordinateData",
] as const satisfies readonly DistributionChartKindV1[];

assert.equal(new Set(chartKinds).size, 7);

const chartData: DistributionChartDataV1 = {
  kind: "histogramData",
  schemaVersion: "1",
  provenance: { methodId: "histogram-v1", snapshotId: "snapshot-1" },
  bins: [{ lower: 0, upper: 1, count: 3 }],
};
assert.equal("observations" in chartData, false);

const bootstrap: DistributionWorkspaceBootstrapV1 = {
  schemaVersion: "1",
  mode: "emptySystem",
  canRun: false,
  datasetCount: 0,
  capabilities: [],
  observationPolicy: { schemaVersion: "1", dimensions: [] },
  resourceBudget: {
    maxGroups: 1_000,
    maxRowsPerGroup: 100_000,
    maxTotalRows: 1_000_000,
    maxTotalBytes: 64 * 1024 * 1024,
    cancelToken: null,
  },
};

assert.equal(bootstrap.mode, "emptySystem");
assert.equal(bootstrap.capabilities.length, 0);
assert.deepEqual(Object.keys(bootstrap.resourceBudget), [
  "maxGroups",
  "maxRowsPerGroup",
  "maxTotalRows",
  "maxTotalBytes",
  "cancelToken",
]);

const invokeCalls: Array<{ command: string; args: unknown }> = [];
Object.assign(globalThis, {
  window: {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: unknown = {}) => {
        invokeCalls.push({ command, args });
        if (command === "bootstrap_distribution_workspace") return bootstrap;
        if (command === "list_distribution_capabilities") return [];
        return undefined;
      },
    },
  },
});

const { distributionService } = await import("../src/services/distributionService.ts");
const bootstrapResult = await distributionService.bootstrapWorkspace();
assert.equal(bootstrapResult.mode, "emptySystem");
assert.equal(bootstrapResult.capabilities.length, 0);
assert.deepEqual(Object.keys(bootstrapResult.resourceBudget), [
  "maxGroups",
  "maxRowsPerGroup",
  "maxTotalRows",
  "maxTotalBytes",
  "cancelToken",
]);

await distributionService.listCapabilities();
const blackBoxCase: BlackBoxCaseV1 = {
  schemaVersion: "1",
  caseId: "case-1",
  actionId: "distribution.summary.v1",
  parameters: {},
  observations: [{ kind: "numeric", outputId: "mean", value: 1 }],
  warningCodes: [],
  provenance: {
    toolVersion: "1",
    inputHash: "sha256:input",
    outputHash: "sha256:output",
    legalReviewStatus: "approved",
  },
};
await distributionService.validateBlackBoxCase(blackBoxCase);

assert.deepEqual(invokeCalls, [
  { command: "bootstrap_distribution_workspace", args: {} },
  { command: "list_distribution_capabilities", args: {} },
  {
    command: "validate_black_box_case",
    args: { case: blackBoxCase },
  },
]);

console.log("distribution contracts OK");