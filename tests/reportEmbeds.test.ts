import assert from "node:assert/strict";

import { resolveReportDependency } from "../src/components/report/ReportEmbed.tsx";
import { useDataStore } from "../src/stores/useDataStore.ts";
import { useFitYByXStore } from "../src/stores/useFitYByXStore.ts";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";
import { useTabulateStore } from "../src/stores/useTabulateStore.ts";
import type { DatasetMeta } from "../src/types/data.ts";
import type { FitYByXItem } from "../src/types/fitYByX.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";
import type { ReportDependency } from "../src/types/report.ts";
import type { TabulateItem } from "../src/types/tabulate.ts";

function createDataset(overrides: Partial<DatasetMeta> & Pick<DatasetMeta, "id" | "name">): DatasetMeta {
  return {
    sourcePath: null,
    sourceType: "manual",
    rowCount: 24,
    colCount: 4,
    createdAt: "2026-09-02T00:00:00.000Z",
    updatedAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function createGraph(overrides: Partial<GraphBuilderItem> & Pick<GraphBuilderItem, "id" | "name" | "sourceDatasetId">): GraphBuilderItem {
  return {
    mode: "2d",
    modeStates: {
      twoD: {
        encoding: {},
        multiX: [],
        multiY: [],
        elements: [],
        smootherLambda: 0,
      },
      threeD: {
        encoding: {},
        elements: [],
        smootherLambda: 0,
      },
      multivariate: {
        columns: [],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
    filters: [],
    sampling: { mode: "full" },
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function createFitYByX(overrides: Partial<FitYByXItem> & Pick<FitYByXItem, "id" | "name" | "sourceDatasetId">): FitYByXItem {
  return {
    response: { name: "strength", type: "continuous" },
    factor: { name: "time", type: "continuous" },
    personality: "bivariate",
    graph: {
      mode: "2d",
      modeStates: {
        twoD: {
          encoding: {},
          multiX: [],
          multiY: [],
          elements: [],
          smootherLambda: 0,
        },
        threeD: {
          encoding: {},
          elements: [],
          smootherLambda: 0,
        },
        multivariate: {
          columns: [],
          chartType: "correlationMatrix",
          correlationMethod: "pearson",
        },
      },
      filters: [],
      sampling: { mode: "full" },
    },
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function createTabulate(overrides: Partial<TabulateItem> & Pick<TabulateItem, "id" | "name" | "sourceDatasetId">): TabulateItem {
  return {
    rowFields: ["supplier"],
    columnFields: ["phase"],
    statistics: [{ id: "count", field: "strength", kind: "count" }],
    includeRowTotals: true,
    includeColumnTotals: true,
    createdAt: "2026-09-02T00:00:00.000Z",
    ...overrides,
  };
}

function resetStores(): void {
  useProjectStore.setState({ readOnly: false });
  useDataStore.setState({ activeDatasetId: null, datasets: [], statusInfo: null });
  useGraphBuilderStore.getState().reset();
  useFitYByXStore.getState().reset();
  useTabulateStore.getState().reset();
}

function assertResolved(
  dependency: ReportDependency,
  expectedName: string,
  expectedDatasetName: string,
): void {
  const resolved = resolveReportDependency(dependency);
  assert.equal(resolved.status, "resolved", `${dependency.kind}:${dependency.documentId} should resolve`);
  assert.equal(resolved.source.name, expectedName);
  assert.equal(resolved.source.dataset.name, expectedDatasetName);
}

resetStores();

const dataset = createDataset({ id: "table-1", name: "Incoming Data" });
useDataStore.setState({ activeDatasetId: null, datasets: [dataset], statusInfo: null });
useGraphBuilderStore.getState().loadFromProject([
  createGraph({ id: "graph-1", name: "Scatter Plot", sourceDatasetId: dataset.id }),
]);
useFitYByXStore.getState().loadFromProject([
  createFitYByX({ id: "fit-1", name: "Strength vs Time", sourceDatasetId: dataset.id }),
]);
useTabulateStore.getState().loadFromProject([
  createTabulate({ id: "tab-1", name: "Grouped Summary", sourceDatasetId: dataset.id }),
]);

assertResolved({ kind: "table", documentId: "table-1" }, "Incoming Data", "Incoming Data");
assertResolved({ kind: "graph", documentId: "graph-1" }, "Scatter Plot", "Incoming Data");
assertResolved({ kind: "fitYByX", documentId: "fit-1" }, "Strength vs Time", "Incoming Data");
assertResolved({ kind: "tabulate", documentId: "tab-1" }, "Grouped Summary", "Incoming Data");

useDataStore.setState({
  activeDatasetId: null,
  datasets: [createDataset({ ...dataset, name: "Incoming Data Renamed" })],
  statusInfo: null,
});
useGraphBuilderStore.getState().renameItem("graph-1", "Scatter Plot Renamed");
useFitYByXStore.getState().renameItem("fit-1", "Strength vs Time Renamed");
useTabulateStore.getState().renameItem("tab-1", "Grouped Summary Renamed");

assertResolved({ kind: "table", documentId: "table-1" }, "Incoming Data Renamed", "Incoming Data Renamed");
assertResolved({ kind: "graph", documentId: "graph-1" }, "Scatter Plot Renamed", "Incoming Data Renamed");
assertResolved({ kind: "fitYByX", documentId: "fit-1" }, "Strength vs Time Renamed", "Incoming Data Renamed");
assertResolved({ kind: "tabulate", documentId: "tab-1" }, "Grouped Summary Renamed", "Incoming Data Renamed");

assert.deepEqual(resolveReportDependency({ kind: "graph", documentId: "missing-graph" }), {
  status: "missing",
  dependency: { kind: "graph", documentId: "missing-graph" },
});
assert.deepEqual(resolveReportDependency({ kind: "table", documentId: "missing-table" }), {
  status: "missing",
  dependency: { kind: "table", documentId: "missing-table" },
});

console.log("report embed resolver contract passed");