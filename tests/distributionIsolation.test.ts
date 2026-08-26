import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import type { OpenProjectResult } from "../src/types/project.ts";

const distributionTypesSource = readFileSync(
  new URL("../src/types/distribution.ts", import.meta.url),
  "utf8",
);
assert.match(
  distributionTypesSource,
  /DistributionLoadStatusV1\s*=\s*"ready"\s*\|\s*"unknownVersion"\s*\|\s*"missingSource"\s*\|\s*"corrupt"/,
);
assert.match(distributionTypesSource, /rawEnvelope\?:\s*Record<string, unknown>/);
assert.match(distributionTypesSource, /rawText\?:\s*string/);

const result: OpenProjectResult = {
  project: { name: "Isolation", filePath: "isolation.spprj", createdAt: "now" },
  history: [],
  snapshots: [],
  graphBuilders: [],
  tabulates: [],
  folders: [],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  datasetNameMigrations: [],
  distributionFolders: {},
  derivedFormulas: [],
  distributions: [
    {
      schemaVersion: "1",
      analysisId: "dist-healthy",
      name: "Healthy",
      sourceDatasetId: "ds-1",
      status: "ready",
      loadStatus: "ready",
      configRevision: 1,
      currentConfig: {
        schemaVersion: "1",
        sourceDatasetId: "ds-1",
        yColumns: [{ columnId: "col-y", modelingType: "continuous" }],
        weightColumnId: null,
        frequencyColumnId: null,
        byColumnIds: [],
        filterExpr: { kind: "isNull", fieldId: "col-y", negate: true },
        confidenceLevel: 0.95,
        histogramsOnly: false,
        enabledCapabilityIds: [],
        capabilityOverrides: [],
      },
    },
    {
      schemaVersion: "unknown",
      analysisId: "dist-corrupt",
      name: "Corrupt",
      sourceDatasetId: "",
      status: "unavailable",
      loadStatus: "corrupt",
      currentConfig: {},
      rawText: "{broken",
    },
  ],
  distributionIssues: [
    {
      analysisId: "dist-corrupt",
      kind: "corrupt",
      messageKey: "distribution.issue.corrupt",
      schemaVersion: "unknown",
    },
  ],
};

const invokeCalls: string[] = [];
Object.assign(globalThis, {
  window: {
    __TAURI_INTERNALS__: {
      invoke: async (command: string) => {
        invokeCalls.push(command);
        return result;
      },
    },
  },
});

const { projectService } = await import("../src/services/projectService.ts");
const { useDistributionStore } = await import("../src/stores/useDistributionStore.ts");
const reopened = await projectService.openProject("isolation.spprj");
useDistributionStore.getState().loadFromProject(
  reopened.distributions,
  reopened.derivedFormulas,
  reopened.distributionIssues,
);

assert.deepEqual(invokeCalls, ["open_project"]);
assert.equal(useDistributionStore.getState().items.length, 2);
assert.equal(
  useDistributionStore.getState().items.find(
    (item) => item.analysisId === "dist-corrupt",
  )?.loadStatus,
  "corrupt",
);
assert.deepEqual(useDistributionStore.getState().issues, [
  {
    analysisId: "dist-corrupt",
    kind: "corrupt",
    messageKey: "distribution.issue.corrupt",
    schemaVersion: "unknown",
  },
]);

useDistributionStore.getState().reset();
console.log("distribution isolation contracts OK");