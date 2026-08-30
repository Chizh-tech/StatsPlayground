import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { createDefaultFitYByXGraphConfig } from "../src/components/fitYByX/fitYByXConfig.ts";
import { createEmbeddedGraphItem, normalizeGraphBuilderItem } from "../src/components/graphBuilder/graphBuilderMode.ts";
import { buildGraphRuntimeModel } from "../src/components/graphBuilder/graphRuntimeModel.ts";
import { deriveGraphRequestParts } from "../src/components/graphBuilder/useGraphDataPipeline.ts";
import type { DatasetMeta } from "../src/types/data.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";

const dataset: DatasetMeta = {
  id: "dataset-1",
  name: "Dataset 1",
  sourcePath: null,
  sourceType: "manual",
  rowCount: 42,
  colCount: 4,
  createdAt: "2026-08-30T00:00:00.000Z",
  updatedAt: "2026-08-30T00:00:00.000Z",
};

const metadata = {
  columns: [
    { colIndex: 0, colName: "site", colType: "VARCHAR", role: "nominal" as const, missingCount: 0 },
    { colIndex: 1, colName: "height", colType: "DOUBLE", role: "continuous" as const, missingCount: 0 },
    { colIndex: 2, colName: "batch", colType: "VARCHAR", role: "ordinal" as const, missingCount: 0 },
  ],
  displayProps: [
    {
      colIndex: 0,
      extras: {
        valueOrder: { values: ["North", "South"] },
      },
    },
    {
      colIndex: 1,
      extras: {
        spec: { lsl: 10, target: 15, usl: 20 },
      },
    },
  ],
};

function makeInteractiveGraphItem(): GraphBuilderItem {
  return normalizeGraphBuilderItem({
    id: "graph-1",
    name: "Graph 1",
    sourceDatasetId: dataset.id,
    createdAt: "2026-08-30T00:00:00.000Z",
    mode: "2d",
    modeStates: {
      twoD: {
        encoding: {
          x: { name: "site", type: "nominal" },
          y: { name: "height", type: "continuous" },
          overlay: { name: "batch", type: "ordinal" },
        },
        multiX: [],
        multiY: [],
        elements: [
          { kind: "points", enabled: true },
          { kind: "boxplot", enabled: true },
        ],
        smootherLambda: 0.4,
        hiddenGroups: ["South"],
        refLinesY: [{ id: "manual-y", y: 12, label: "goal", color: "#00C853", style: "solid", width: 1 }],
        autoSpecLinesY: true,
      },
      threeD: {
        encoding: {},
        elements: [{ kind: "scatter3d", enabled: true }],
        smootherLambda: 0.4,
      },
      multivariate: {
        columns: [],
        chartType: "correlationMatrix",
        correlationMethod: "pearson",
      },
    },
    filters: [{ op: "AND", rule: { kind: "categorical", field: "site", selected: ["North"] } }],
    sampling: { mode: "full" },
  });
}

const interactiveItem = makeInteractiveGraphItem();
const embeddedItem = createEmbeddedGraphItem({
  id: "fit-y-by-x-graph:fit-1",
  name: "Fit Y by X 1",
  sourceDatasetId: dataset.id,
  createdAt: interactiveItem.createdAt,
  config: createDefaultFitYByXGraphConfig({
    response: { name: "height", type: "continuous" },
    factor: { name: "site", type: "nominal" },
  }),
});

assert.deepEqual(
  deriveGraphRequestParts(interactiveItem),
  deriveGraphRequestParts(
    createEmbeddedGraphItem({
      id: "graph-embedded-1",
      name: interactiveItem.name,
      sourceDatasetId: interactiveItem.sourceDatasetId,
      createdAt: interactiveItem.createdAt,
      config: {
        mode: interactiveItem.mode,
        modeStates: interactiveItem.modeStates,
        filters: interactiveItem.filters,
        sampling: interactiveItem.sampling,
      },
    }),
  ),
);

assert.deepEqual(
  buildGraphRuntimeModel(interactiveItem, metadata),
  buildGraphRuntimeModel(
    createEmbeddedGraphItem({
      id: "graph-embedded-1",
      name: interactiveItem.name,
      sourceDatasetId: interactiveItem.sourceDatasetId,
      createdAt: interactiveItem.createdAt,
      config: {
        mode: interactiveItem.mode,
        modeStates: interactiveItem.modeStates,
        filters: interactiveItem.filters,
        sampling: interactiveItem.sampling,
      },
    }),
    metadata,
  ),
);

assert.deepEqual(
  deriveGraphRequestParts(embeddedItem),
  deriveGraphRequestParts(
    normalizeGraphBuilderItem({
      ...embeddedItem,
      id: "fit-y-by-x-graph:interactive",
      name: "Fit Y by X Interactive",
    }),
  ),
);

assert.deepEqual(
  buildGraphRuntimeModel(embeddedItem, metadata),
  buildGraphRuntimeModel(
    normalizeGraphBuilderItem({
      ...embeddedItem,
      id: "fit-y-by-x-graph:interactive",
      name: "Fit Y by X Interactive",
    }),
    metadata,
  ),
);

const graphRuntimeSource = readFileSync(
  resolve(process.cwd(), "src/components/graphBuilder/GraphRuntime.tsx"),
  "utf8",
);
assert.equal(
  graphRuntimeSource.includes("useGraphBuilderStore"),
  false,
  "GraphRuntime must not import or reference useGraphBuilderStore",
);

console.log("graphRuntime contract tests passed");