import assert from "node:assert/strict";

const [
  { createFitYByXItem },
  { createEmbeddedGraphItem },
  { useGraphBuilderStore },
  { useProjectStore },
  { useFitYByXStore },
] = await Promise.all([
  import("../src/components/fitYByX/fitYByXConfig.ts"),
  import("../src/components/graphBuilder/graphBuilderMode.ts"),
  import("../src/stores/useGraphBuilderStore.ts"),
  import("../src/stores/useProjectStore.ts"),
  import("../src/stores/index.ts"),
]);

const response = { name: "height", type: "continuous" as const };
const factor = { name: "site", type: "nominal" as const };
const createdAt = "2026-08-30T00:00:00.000Z";

function fitItem(id: string, name: string, datasetId = "dataset-1") {
  return createFitYByXItem({
    id,
    name,
    sourceDatasetId: datasetId,
    response,
    factor,
    createdAt,
  });
}

function resetStores() {
  useProjectStore.setState({ readOnly: false });
  useFitYByXStore.getState().reset();
  useGraphBuilderStore.getState().reset();
}

resetStores();

const loadedBase = fitItem("fit-2", "Fit Y by X 2");
const loadedCustom = fitItem("fit-custom", "Custom fit", "dataset-2");
const persistedGraph = {
  ...loadedBase.graph,
  mode: "2d" as const,
  modeStates: {
    ...loadedBase.graph.modeStates,
    twoD: {
      ...loadedBase.graph.modeStates.twoD,
      smootherLambda: 0.8,
      elements: [{ kind: "points", enabled: false }],
      hiddenGroups: ["site:B"],
      yAxis: { min: 10, max: 20 },
    },
  },
};
const expectedPersistedGraph = createEmbeddedGraphItem({
  id: "fit-y-by-x-graph:fit-2",
  name: "Fit Y by X 2",
  sourceDatasetId: "dataset-1",
  config: persistedGraph,
  createdAt,
});

useFitYByXStore.getState().loadFromProject([
  { ...loadedBase, graph: persistedGraph },
  loadedCustom,
  { ...fitItem("fit-legacy", "Legacy fit"), graph: undefined } as never,
  { ...fitItem("fit-malformed", "Malformed fit"), graph: { mode: "bogus" } } as never,
  {
    ...fitItem("fit-partial", "Partial fit"),
    graph: {
      mode: "2d",
      modeStates: { twoD: {}, threeD: {}, multivariate: {} },
    },
  } as never,
  {
    ...fitItem("fit-invalid-roles", "Fit Y by X 99"),
    response: factor,
  } as never,
]);

const loadedItem = useFitYByXStore.getState().items.find(({ id }) => id === "fit-2");
assert.ok(loadedItem);
assert.deepEqual(loadedItem?.graph, {
  mode: expectedPersistedGraph.mode,
  modeStates: expectedPersistedGraph.modeStates,
  filters: expectedPersistedGraph.filters,
  sampling: expectedPersistedGraph.sampling,
});
assert.deepEqual(loadedItem?.response, response);
assert.deepEqual(loadedItem?.factor, factor);
assert.equal(loadedItem?.createdAt, createdAt);
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-legacy")?.graph,
  fitItem("fit-legacy", "Legacy fit").graph,
);
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-malformed")?.graph,
  fitItem("fit-malformed", "Malformed fit").graph,
);
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-partial")?.graph,
  fitItem("fit-partial", "Partial fit").graph,
);
assert.equal(
  useFitYByXStore.getState().items.some(({ id }) => id === "fit-invalid-roles"),
  false,
);
assert.equal(useFitYByXStore.getState().nextName(), "Fit Y by X 3");
assert.deepEqual(useGraphBuilderStore.getState().items, []);

useFitYByXStore.getState().addItem(fitItem("fit-8", "Fit Y by X 8"));
assert.equal(useFitYByXStore.getState().nextName(), "Fit Y by X 9");

useFitYByXStore.getState().updateItem("fit-2", {
  sourceDatasetId: "dataset-9",
  response: { name: "weight", type: "continuous" },
});
assert.equal(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-2")?.sourceDatasetId,
  "dataset-9",
);
assert.deepEqual(
  useFitYByXStore.getState().items.find(({ id }) => id === "fit-2")?.response,
  { name: "weight", type: "continuous" },
);

useFitYByXStore.getState().renameItem("fit-custom", "Fit Y by X 12");
assert.equal(useFitYByXStore.getState().nextName(), "Fit Y by X 13");

useFitYByXStore.getState().deleteByDataset("dataset-9");
assert.equal(useFitYByXStore.getState().items.some(({ id }) => id === "fit-2"), false);

useFitYByXStore.getState().deleteItem("fit-8");
assert.deepEqual(
  useFitYByXStore.getState().items.map(({ id }) => id),
  ["fit-custom", "fit-legacy", "fit-malformed", "fit-partial"],
);

useProjectStore.setState({ readOnly: true });
assert.throws(
  () => useFitYByXStore.getState().addItem(fitItem("blocked", "Fit Y by X 99")),
  /Project is read-only while save is in progress\./,
);
assert.throws(
  () => useFitYByXStore.getState().nextName(),
  /Project is read-only while save is in progress\./,
);
useProjectStore.setState({ readOnly: false });

const unexpectedItem = fitItem("fit-unexpected", "Unexpected fit");
Object.defineProperty(unexpectedItem, "id", {
  get() {
    throw new Error("unexpected normalization failure");
  },
});
assert.throws(
  () => useFitYByXStore.getState().loadFromProject([unexpectedItem]),
  /unexpected normalization failure/,
);

useFitYByXStore.getState().reset();
assert.deepEqual(useFitYByXStore.getState().items, []);
assert.equal(useFitYByXStore.getState().counter, 0);

console.log("fitYByX store contract passed");