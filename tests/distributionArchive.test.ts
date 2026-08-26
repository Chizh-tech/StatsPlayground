import assert from "node:assert/strict";

import type {
  DerivedFormulaDocV1,
  DistributionDocV1,
} from "../src/types/distribution.ts";

const distribution: DistributionDocV1 = {
  schemaVersion: "1",
  analysisId: "dist-001",
  name: "Distribution 1",
  sourceDatasetId: "ds-42",
  status: "ready",
  currentConfig: {
    mode: "continuous",
    filterExpr: { kind: "isNull", fieldId: "region" },
  },
};
const formula: DerivedFormulaDocV1 = {
  formulaId: "formula-001",
  schemaVersion: "1",
  analysisId: "dist-001",
  sourceDatasetId: "ds-42",
  sourceColumnIds: ["sales-amount-id"],
  outputColumnName: "Standardized Sales",
  ast: { kind: "column", columnId: "sales-amount-id" },
  fingerprint: "sha256:formula-001",
};
const openResult = {
  project: { name: "Project", filePath: "project.spprj", createdAt: "now" },
  history: [],
  snapshots: [],
  graphBuilders: [],
  tabulates: [],
  distributions: [distribution],
  derivedFormulas: [formula],
  distributionIssues: [],
  folders: ["Analyses", "Analyses/Revenue"],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  distributionFolders: { "dist-001": "Analyses/Revenue" },
  datasetNameMigrations: [],
};
const invokeCalls: Array<{ command: string; args: Record<string, unknown> }> = [];
Object.assign(globalThis, {
  window: {
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: Record<string, unknown> = {}) => {
        invokeCalls.push({ command, args });
        if (command === "open_project") return openResult;
        return openResult.project;
      },
    },
  },
});

const { projectService } = await import("../src/services/projectService.ts");
const folders = {
  folders: ["Analyses", "Analyses/Revenue"],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  distributionFolders: { "dist-001": "Analyses/Revenue" },
};
await projectService.saveProject(
  undefined,
  [],
  [],
  [],
  folders,
  [],
  [distribution],
  [formula],
  [],
);
const reopened = await projectService.openProject("project.spprj");

assert.deepEqual(invokeCalls[0], {
  command: "save_project",
  args: {
    filePath: null,
    history: [],
    snapshots: [],
    graphBuilders: [],
    tabulates: [],
    distributions: [distribution],
    derivedFormulas: [formula],
    distributionIssues: [],
    folders: ["Analyses", "Analyses/Revenue"],
    tableFolders: {},
    graphFolders: {},
    tabulateFolders: {},
    distributionFolders: { "dist-001": "Analyses/Revenue" },
  },
});
assert.deepEqual(reopened.distributions, [distribution]);
assert.deepEqual(reopened.derivedFormulas, [formula]);
assert.deepEqual(reopened.distributionFolders, {
  "dist-001": "Analyses/Revenue",
});

const { useDistributionStore } = await import("../src/stores/useDistributionStore.ts");
const { useFolderStore } = await import("../src/stores/useFolderStore.ts");
useDistributionStore.getState().loadFromProject(
  reopened.distributions,
  reopened.derivedFormulas,
  reopened.distributionIssues,
);
assert.deepEqual(useDistributionStore.getState().items, [distribution]);
assert.deepEqual(useDistributionStore.getState().derivedFormulas, [formula]);
assert.equal(useDistributionStore.getState().selectedAnalysisId, null);

useFolderStore.getState().loadFromProject({
  folders: [],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
  distributionFolders: { "dist-001": "/Analyses//Revenue/" },
});
assert.deepEqual(useFolderStore.getState().distributionFolders, {
  "dist-001": "Analyses/Revenue",
});
assert.deepEqual(useFolderStore.getState().folders, ["Analyses", "Analyses/Revenue"]);

useDistributionStore.getState().reset();
useFolderStore.getState().reset();
assert.deepEqual(useDistributionStore.getState().items, []);
assert.deepEqual(useDistributionStore.getState().derivedFormulas, []);
assert.deepEqual(useFolderStore.getState().distributionFolders, {});

console.log("distribution archive contracts OK");