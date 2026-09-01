import { expect, test } from "@playwright/experimental-ct-react";

import { DistributionDirectoryItem } from "../../src/components/distribution";
import type { LoadedDistributionDocV1 } from "../../src/types/distribution";

const item: LoadedDistributionDocV1 = {
  schemaVersion: "1",
  analysisId: "analysis-stable-1",
  name: "Distribution 1",
  sourceDatasetId: "dataset-1",
  status: "ready",
  loadStatus: "ready",
  configRevision: 1,
  currentConfig: {
    schemaVersion: "1",
    sourceDatasetId: "dataset-1",
    yColumns: [{ columnId: "value", modelingType: "continuous" }],
    weightColumnId: null,
    frequencyColumnId: null,
    byColumnIds: [],
    filterExpr: { kind: "and", exprs: [] },
    confidenceLevel: 0.95,
    histogramsOnly: false,
    enabledCapabilityIds: [],
    capabilityOverrides: [],
  },
};

test("routes directory actions through the stable analysis ID", async ({ mount }) => {
  const actions: Array<[string, string, string?]> = [];
  const component = await mount(
    <DistributionDirectoryItem
      item={item}
      sourceName="Dataset 1"
      selected={false}
      onSelect={(id) => actions.push(["select", id])}
      onRename={(id, name) => actions.push(["rename", id, name])}
      onCopy={(id) => actions.push(["copy", id])}
      onDelete={(id) => actions.push(["delete", id])}
      onOpenSource={(id) => actions.push(["openSource", id])}
    />,
  );

  await component.click();
  await component.dblclick();
  await component.getByRole("textbox", { name: "Rename Distribution 1" }).fill("Revenue");
  await component.getByRole("textbox", { name: "Rename Distribution 1" }).press("Enter");
  await component.click({ button: "right" });
  await component.getByRole("button", { name: "Copy" }).click();
  await component.click({ button: "right" });
  await component.getByRole("button", { name: "Delete" }).click();
  await component.click({ button: "right" });
  await component.getByTestId("distribution-open-source").click();

  assertActionsUseStableId(actions);
  expect(actions.filter(([action]) => action === "select").length).toBeGreaterThanOrEqual(1);
  expect(actions.filter(([action]) => action !== "select")).toEqual([
    ["rename", "analysis-stable-1", "Revenue"],
    ["copy", "analysis-stable-1"],
    ["delete", "analysis-stable-1"],
    ["openSource", "analysis-stable-1"],
  ]);
});

test("does not copy preserved unknown documents", async ({ mount }) => {
  const component = await mount(
    <DistributionDirectoryItem
      item={{
        schemaVersion: "99",
        analysisId: "future-1",
        name: "Future Distribution",
        sourceDatasetId: "dataset-1",
        status: "unavailable",
        loadStatus: "unknownVersion",
        currentConfig: {},
        rawEnvelope: {},
      }}
      sourceName="Dataset 1"
      selected={false}
      onSelect={() => {}}
      onRename={() => {}}
      onCopy={() => {}}
      onDelete={() => {}}
      onOpenSource={() => {}}
    />,
  );

  await component.click({ button: "right" });
  await expect(component.getByRole("button", { name: "Copy" })).toBeDisabled();
  await component.unmount();

  const corrupt = await mount(
    <DistributionDirectoryItem
      item={{
        schemaVersion: "unknown",
        analysisId: "corrupt-1",
        name: "Corrupt Distribution",
        sourceDatasetId: "dataset-1",
        status: "unavailable",
        loadStatus: "corrupt",
        currentConfig: {},
        rawText: "{broken",
      }}
      sourceName="Dataset 1"
      selected={false}
      onSelect={() => {}}
      onRename={() => {}}
      onCopy={() => {}}
      onDelete={() => {}}
      onOpenSource={() => {}}
    />,
  );
  await corrupt.click({ button: "right" });
  await expect(corrupt.getByRole("button", { name: "Copy" })).toBeDisabled();
});

function assertActionsUseStableId(actions: Array<[string, string, string?]>) {
  expect(actions.every(([, analysisId]) => analysisId === "analysis-stable-1")).toBe(true);
}