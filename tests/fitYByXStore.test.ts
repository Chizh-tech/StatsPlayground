import assert from "node:assert/strict";

import { createFitYByXItem } from "../src/components/fitYByX/fitYByXConfig.ts";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore.ts";
import { useProjectStore } from "../src/stores/useProjectStore.ts";

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

const { useFitYByXStore } = await import("../src/stores/index.ts");

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
      multiX: [{ name: "extra", type: "continuous" as const }],
      multiY: [{ name: "drop", type: "continuous" as const }],
      elements: [{ kind: "line", enabled: true }],
    },
  },
};

useFitYByXStore.getState().loadFromProject([
  { ...loadedBase, graph: persistedGraph },
  loadedCustom,
]);

const loadedItem = useFitYByXStore.getState().items.find(({ id }) => id === "fit-2");
assert.ok(loadedItem);
assert.deepEqual(loadedItem?.graph, loadedBase.graph);
assert.deepEqual(loadedItem?.response, response);
assert.deepEqual(loadedItem?.factor, factor);
assert.equal(loadedItem?.createdAt, createdAt);
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
  ["fit-custom"],
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

useFitYByXStore.getState().reset();
assert.deepEqual(useFitYByXStore.getState().items, []);
assert.equal(useFitYByXStore.getState().counter, 0);

console.log("fitYByX store contract passed");