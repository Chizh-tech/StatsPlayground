import assert from "node:assert/strict";

import type {
  DerivedFormulaDocV1,
  DistributionDocV1,
  DistributionContinuousFitConfigV1,
} from "../src/types/distribution.ts";

const distribution: DistributionDocV1 = {
  schemaVersion: "1",
  analysisId: "dist-001",
  name: "Distribution 1",
  sourceDatasetId: "ds-42",
  status: "ready",
  loadStatus: "ready",
  configRevision: 1,
  currentConfig: {
    schemaVersion: "1",
    sourceDatasetId: "ds-42",
    yColumns: [{ columnId: "sales-amount-id", modelingType: "continuous" }],
    weightColumnId: null,
    frequencyColumnId: null,
    byColumnIds: [],
    filterExpr: { kind: "isNull", fieldId: "region", negate: true },
    confidenceLevel: 0.95,
    histogramsOnly: false,
    continuousFit: {
      enabledDistributionIds: ["normal", "weibull"],
      fitAll: false,
      diagnostics: {
        goodnessOfFit: false,
        qqPlot: false,
        cdfPlot: false,
        ppPlot: false,
      },
    } satisfies DistributionContinuousFitConfigV1,
    visualDiagnostics: {
      histogram: {
        method: "fixedWidth",
        fixedCount: null,
        fixedWidth: 0.25,
      },
      normalQuantileConfidenceLevel: 0.95,
    },
    enabledCapabilityIds: ["capability.normal.individuals"],
    capabilityOverrides: [{
      schemaVersion: "1",
      capabilityId: "capability.normal.individuals",
      payloadSchemaVersion: "1",
      payload: { lsl: 10, target: 15, usl: 20 },
    }],
    reportPreferences: {
      "sales-amount-id": {
        overview: true,
        histogram: true,
        outlierBoxPlot: true,
        specificationLines: true,
        quantiles: true,
        summary: true,
        horizontalTables: false,
        normalQuantilePlot: true,
        ecdf: true,
        processCapability: true,
        histogramScale: "density",
        capabilityHistogram: false,
        capabilityProcessSummary: true,
        capabilityWithin: false,
        capabilityOverall: true,
        capabilityNonconformance: false,
      },
    },
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
assert.deepEqual(
  reopened.distributions[0]?.currentConfig.continuousFit,
  distribution.currentConfig.continuousFit,
);
assert.deepEqual(reopened.distributionFolders, {
  "dist-001": "Analyses/Revenue",
});

const { useDistributionStore } = await import("../src/stores/useDistributionStore.ts");
const { useFolderStore } = await import("../src/stores/useFolderStore.ts");
useDistributionStore.getState().loadFromProject(
  reopened.distributions.map((item) => ({
    ...item,
    currentConfig: {
      ...item.currentConfig,
      reportPreferences: {
        ...item.currentConfig.reportPreferences,
        "sales-amount-id": {
          ...item.currentConfig.reportPreferences?.["sales-amount-id"],
          quantileBoxPlot: true,
          stemAndLeaf: true,
        },
      },
    },
  })) as DistributionDocV1[],
  reopened.derivedFormulas,
  reopened.distributionIssues,
);
assert.deepEqual(useDistributionStore.getState().items, [distribution]);
const migratedPreferences = useDistributionStore.getState().items[0]?.currentConfig
  .reportPreferences?.["sales-amount-id"] as Record<string, unknown>;
assert.equal("quantileBoxPlot" in migratedPreferences, false);
assert.equal("stemAndLeaf" in migratedPreferences, false);
assert.deepEqual(useDistributionStore.getState().derivedFormulas, [formula]);
assert.deepEqual(
  useDistributionStore.getState().items[0]?.currentConfig.continuousFit,
  distribution.currentConfig.continuousFit,
);
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

useFolderStore.getState().setDistributionFolder("dist-001", "Analyses/Regional");
assert.equal(
  useFolderStore.getState().distributionFolders["dist-001"],
  "Analyses/Regional",
);
const copiedDistribution = useDistributionStore.getState().copyItem("dist-001");
assert.ok(copiedDistribution);
useFolderStore.getState().setDistributionFolder(
  copiedDistribution.analysisId,
  useFolderStore.getState().distributionFolders["dist-001"] ?? null,
);
assert.notEqual(copiedDistribution.analysisId, "dist-001");
assert.equal(
  useFolderStore.getState().distributionFolders[copiedDistribution.analysisId],
  "Analyses/Regional",
);

useDistributionStore.getState().reset();
useFolderStore.getState().reset();
assert.deepEqual(useDistributionStore.getState().items, []);
assert.deepEqual(useDistributionStore.getState().derivedFormulas, []);
assert.deepEqual(useFolderStore.getState().distributionFolders, {});

console.log("distribution archive contracts OK");