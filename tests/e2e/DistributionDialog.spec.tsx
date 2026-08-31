import { expect, test } from "@playwright/experimental-ct-react";

import { DistributionDialog } from "../../src/components/distribution";
import type {
  DistributionAnalysisConfigV1,
  DistributionColumnInfoV1,
  DistributionWorkspaceBootstrapV1,
} from "../../src/types/distribution";

const columns: DistributionColumnInfoV1[] = [
  {
    columnId: "Value",
    sqlType: "DOUBLE",
    modelingType: "continuous",
    integerCompatible: false,
  },
  {
    columnId: "Count",
    sqlType: "INTEGER",
    modelingType: "continuous",
    integerCompatible: true,
  },
  {
    columnId: "Group",
    sqlType: "VARCHAR",
    modelingType: "nominal",
    integerCompatible: false,
  },
  {
    columnId: "Measure",
    sqlType: "DOUBLE",
    modelingType: "continuous",
    integerCompatible: false,
  },
  {
    columnId: "Mass",
    sqlType: "DOUBLE",
    modelingType: "continuous",
    integerCompatible: false,
  },
  {
    columnId: "Mass2",
    sqlType: "DOUBLE",
    modelingType: "continuous",
    integerCompatible: false,
  },
  {
    columnId: "Count2",
    sqlType: "INTEGER",
    modelingType: "continuous",
    integerCompatible: true,
  },
  {
    columnId: "Batch",
    sqlType: "VARCHAR",
    modelingType: "nominal",
    integerCompatible: false,
  },
];

const bootstrap: DistributionWorkspaceBootstrapV1 = {
  schemaVersion: "1",
  mode: "emptySystem",
  canRun: false,
  datasetCount: 1,
  capabilities: [],
  observationPolicy: { schemaVersion: "1", dimensions: [] },
  resourceBudget: {
    maxGroups: 1000,
    maxRowsPerGroup: 100000,
    maxTotalRows: 1000000,
    maxTotalBytes: 67108864,
    cancelToken: null,
  },
};

test("builds and saves a role configuration while run is unavailable", async ({ mount }) => {
  let saved: DistributionAnalysisConfigV1 | null = null;
  let runCalls = 0;
  const component = await mount(
    <DistributionDialog
      open
      datasetId="dataset-1"
      columns={columns}
      bootstrap={bootstrap}
      onSave={async (config) => { saved = config; }}
      onRun={async () => { runCalls += 1; }}
      onCancel={() => {}}
    />,
  );

  await component.getByTestId("distribution-column-search").fill("Value");
  await expect(component.getByText("Group", { exact: true })).toHaveCount(0);
  await component.getByTestId("distribution-column-Value").dragTo(component.getByTestId("distribution-role-y"));
  await component.getByTestId("distribution-column-search").fill("");
  await component.getByTestId("distribution-assign-y-Measure").click();
  await component.getByTestId("distribution-assign-weight-Mass").click();
  await component.getByTestId("distribution-assign-weight-Mass2").click();
  await component.getByTestId("distribution-assign-frequency-Count").click();
  await component.getByTestId("distribution-assign-frequency-Count2").click();
  await component.getByTestId("distribution-assign-by-Group").click();
  await component.getByTestId("distribution-assign-by-Batch").click();

  await expect(component.getByTestId("distribution-confidence-level")).toHaveValue("0.95");
  await expect(component.getByTestId("distribution-run")).toBeDisabled();
  await expect(component.getByTestId("distribution-run-disabled-hint")).toBeVisible();
  await component.getByTestId("distribution-save").click();

  expect(saved).not.toBeNull();
  expect(saved?.yColumns.map((column) => column.columnId)).toEqual(["Value", "Measure"]);
  expect(saved?.weightColumnId).toBe("Mass2");
  expect(saved?.frequencyColumnId).toBe("Count2");
  expect(saved?.byColumnIds).toEqual(["Group", "Batch"]);
  expect(runCalls).toBe(0);
});

test("remove, recall, and cancel preserve the committed initial config", async ({ mount }) => {
  let cancelCalls = 0;
  let saveCalls = 0;
  const initialConfig: DistributionAnalysisConfigV1 = {
    schemaVersion: "1",
    sourceDatasetId: "dataset-1",
    yColumns: [{ columnId: "Value", modelingType: "continuous" }],
    weightColumnId: null,
    frequencyColumnId: null,
    byColumnIds: [],
    filterExpr: { kind: "and", exprs: [] },
    confidenceLevel: 0.95,
    histogramsOnly: false,
    enabledCapabilityIds: [],
    capabilityOverrides: [],
  };
  const component = await mount(
    <DistributionDialog
      open
      datasetId="dataset-1"
      columns={columns}
      initialConfig={initialConfig}
      recallConfig={initialConfig}
      bootstrap={bootstrap}
      onSave={async () => { saveCalls += 1; }}
      onRun={async () => {}}
      onCancel={() => { cancelCalls += 1; }}
    />,
  );

  await component.getByTestId("distribution-remove-y-Value").click();
  await expect(component.getByTestId("distribution-save")).toBeDisabled();
  await component.getByTestId("distribution-recall").click();
  await expect(component.getByTestId("distribution-remove-y-Value")).toBeVisible();
  await component.getByTestId("distribution-cancel").click();
  expect(cancelCalls).toBe(1);
  expect(saveCalls).toBe(0);
});

test("recall normalizes legacy continuous fit config to the disabled default", async ({ mount }) => {
  let saved: DistributionAnalysisConfigV1 | null = null;
  const legacyRecallConfig: DistributionAnalysisConfigV1 = {
    schemaVersion: "1",
    sourceDatasetId: "dataset-1",
    yColumns: [{ columnId: "Value", modelingType: "continuous" }],
    weightColumnId: null,
    frequencyColumnId: null,
    byColumnIds: [],
    filterExpr: { kind: "and", exprs: [] },
    confidenceLevel: 0.95,
    histogramsOnly: false,
    visualDiagnostics: {
      histogram: {
        method: "jmpAuto",
        fixedCount: null,
        fixedWidth: null,
      },
      normalQuantileConfidenceLevel: 0.95,
    },
    enabledCapabilityIds: [],
    capabilityOverrides: [],
  };
  const component = await mount(
    <DistributionDialog
      open
      datasetId="dataset-1"
      columns={columns}
      bootstrap={bootstrap}
      initialConfig={{
        ...legacyRecallConfig,
        continuousFit: {
          enabledDistributionIds: ["normal"],
          fitAll: false,
          diagnostics: {
            goodnessOfFit: false,
            qqPlot: false,
            cdfPlot: false,
            ppPlot: false,
          },
        },
      }}
      recallConfig={legacyRecallConfig}
      onSave={async (config) => { saved = config; }}
      onRun={async () => {}}
      onCancel={() => {}}
    />,
  );

  await component.getByTestId("distribution-recall").click();
  await component.getByTestId("distribution-save").click();

  expect(saved?.continuousFit).toEqual({
    enabledDistributionIds: [],
    fitAll: false,
    diagnostics: {
      goodnessOfFit: false,
      qqPlot: false,
      cdfPlot: false,
      ppPlot: false,
    },
  });
});

test("blocks save when one column is assigned to conflicting roles", async ({ mount }) => {
  const component = await mount(
    <DistributionDialog
      open
      datasetId="dataset-1"
      columns={columns}
      bootstrap={bootstrap}
      onSave={async () => {}}
      onRun={async () => {}}
      onCancel={() => {}}
    />,
  );

  await component.getByTestId("distribution-assign-y-Value").click();
  await component.getByTestId("distribution-assign-by-Value").click();
  await expect(component.getByTestId("distribution-save")).toBeDisabled();
  await expect(component.getByTestId("distribution-run")).toBeDisabled();
});

test("requests replacement columns when the source dataset changes", async ({ mount }) => {
  let replacementDatasetId: string | null = null;
  const component = await mount(
    <DistributionDialog
      open
      datasetId="dataset-1"
      datasets={[
        { id: "dataset-1", name: "Dataset 1" },
        { id: "dataset-2", name: "Dataset 2" },
      ]}
      columns={columns}
      bootstrap={bootstrap}
      onDatasetChange={async (datasetId) => { replacementDatasetId = datasetId; }}
      onSave={async () => {}}
      onRun={async () => {}}
      onCancel={() => {}}
    />,
  );

  await component.getByRole("combobox").selectOption("dataset-2");
  expect(replacementDatasetId).toBe("dataset-2");
});

test("keeps role actions understandable and options separated at narrow width", async ({ mount, page }) => {
  await page.setViewportSize({ width: 768, height: 900 });
  const component = await mount(
    <DistributionDialog
      open
      datasetId="dataset-1"
      datasets={[{ id: "dataset-1", name: "Dataset 1" }]}
      columns={columns}
      bootstrap={bootstrap}
      onSave={async () => {}}
      onRun={async () => {}}
      onCancel={() => {}}
    />,
  );

  await expect(component.getByTestId("distribution-assign-weight-Value")).toHaveText("Weight");
  await expect(component.getByTestId("distribution-assign-frequency-Count")).toHaveText("Freq");

  const confidenceBox = await component
    .getByTestId("distribution-confidence-level")
    .boundingBox();
  const histogramBox = await component
    .locator('input[type="checkbox"]')
    .boundingBox();
  expect(confidenceBox).not.toBeNull();
  expect(histogramBox).not.toBeNull();
  expect(confidenceBox!.x + confidenceBox!.width + 12).toBeLessThanOrEqual(histogramBox!.x);

  const yBox = await component.getByTestId("distribution-role-y").boundingBox();
  const weightBox = await component.getByTestId("distribution-role-weight").boundingBox();
  expect(yBox).not.toBeNull();
  expect(weightBox).not.toBeNull();
  expect(Math.abs(yBox!.x - weightBox!.x)).toBeLessThanOrEqual(1);
  expect(yBox!.y + yBox!.height).toBeLessThanOrEqual(weightBox!.y);
  const hasHorizontalOverflow = await component.locator(".distribution-dialog").evaluate(
    (dialog) => dialog.scrollWidth > dialog.clientWidth,
  );
  expect(hasHorizontalOverflow).toBe(false);
});

test("prevents incompatible columns from entering numeric roles", async ({ mount }) => {
  const component = await mount(
    <DistributionDialog
      open
      datasetId="dataset-1"
      columns={columns}
      bootstrap={bootstrap}
      onSave={async () => {}}
      onRun={async () => {}}
      onCancel={() => {}}
    />,
  );

  await expect(component.getByTestId("distribution-assign-y-Group")).toBeDisabled();
  await expect(component.getByTestId("distribution-assign-weight-Group")).toBeDisabled();
  await expect(component.getByTestId("distribution-assign-frequency-Group")).toBeDisabled();
  await component.getByTestId("distribution-column-Group").dragTo(
    component.getByTestId("distribution-role-frequency"),
  );
  await expect(component.getByTestId("distribution-remove-frequency-Group")).toHaveCount(0);
});

test("enables Run for a valid continuous configuration when capabilities are available", async ({ mount }) => {
  let runConfig: DistributionAnalysisConfigV1 | null = null;
  const component = await mount(
    <DistributionDialog
      open
      datasetId="dataset-1"
      columns={columns}
      bootstrap={{
        ...bootstrap,
        mode: "continuous",
        canRun: true,
        capabilities: [{
          id: "summary.continuous.core",
          titleKey: "distribution.capability.summary.continuous.core",
          scope: "continuousY",
          menuScope: "distribution",
          statusKey: "distribution.capability.available",
        }],
      }}
      onSave={async () => {}}
      onRun={async (config) => { runConfig = config; }}
      onCancel={() => {}}
    />,
  );

  await component.getByTestId("distribution-assign-y-Value").click();
  await expect(component.getByTestId("distribution-run")).toBeEnabled();
  await component.getByTestId("distribution-run").click();
  expect(runConfig?.yColumns.map((column) => column.columnId)).toEqual(["Value"]);
});

test("edits validates and removes the Normal Capability analysis override", async ({ mount }) => {
  let saved: DistributionAnalysisConfigV1 | null = null;
  const capabilityBootstrap: DistributionWorkspaceBootstrapV1 = {
    ...bootstrap,
    mode: "continuous",
    canRun: true,
    capabilities: [{
      id: "capability.normal.individuals",
      titleKey: "distribution.capability.capability.normal.individuals",
      scope: "continuousY",
      menuScope: "distribution",
      statusKey: "distribution.capability.available",
    }],
  };
  const component = await mount(
    <DistributionDialog
      open
      datasetId="dataset-1"
      columns={columns}
      bootstrap={capabilityBootstrap}
      onSave={async (config) => { saved = config; }}
      onRun={async () => {}}
      onCancel={() => {}}
    />,
  );

  await component.getByTestId("distribution-assign-y-Value").click();
  await component.getByRole("checkbox", { name: "Use analysis specification override" }).check();
  await component.getByLabel("Lower specification limit").fill("10");
  await component.getByLabel("Upper specification limit").fill("5");
  await expect(component.getByTestId("distribution-save")).toBeDisabled();
  await component.getByLabel("Upper specification limit").fill("20");
  await component.getByLabel("Target").fill("15");
  await expect(component.getByTestId("distribution-save")).toBeEnabled();
  await component.getByTestId("distribution-save").click();

  expect(saved?.enabledCapabilityIds).toContain("capability.normal.individuals");
  expect(saved?.capabilityOverrides).toEqual([{
    schemaVersion: "1",
    capabilityId: "capability.normal.individuals",
    payloadSchemaVersion: "1",
    payload: { lsl: 10, target: 15, usl: 20 },
  }]);

  await component.getByRole("checkbox", { name: "Use analysis specification override" }).uncheck();
  await component.getByTestId("distribution-save").click();
  expect(saved?.capabilityOverrides).toEqual([]);
});

test("keeps actions visible and long assignments readable in a fixed window", async ({ mount, page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  const longColumn = {
    columnId: "long-column-id",
    name: "sales_amount_with_a_very_long_descriptive_name",
    sqlType: "DOUBLE",
    role: "continuous",
    index: 0,
    modelingType: "continuous" as const,
    integerCompatible: false,
  };
  const component = await mount(
    <DistributionDialog
      open
      datasetId="dataset-1"
      columns={[longColumn, ...columns]}
      bootstrap={bootstrap}
      onSave={async () => {}}
      onRun={async () => {}}
      onCancel={() => {}}
    />,
  );

  await component.getByTestId("distribution-assign-y-long-column-id").click();
  const dialogBox = await component.locator(".distribution-dialog").boundingBox();
  const actionsBox = await component.locator(".dialog-actions").boundingBox();
  const chipBox = await component.getByTestId("distribution-remove-y-long-column-id").locator("..").boundingBox();
  expect(dialogBox).not.toBeNull();
  expect(actionsBox).not.toBeNull();
  expect(chipBox).not.toBeNull();
  expect(actionsBox!.y + actionsBox!.height).toBeLessThanOrEqual(dialogBox!.y + dialogBox!.height + 1);
  expect(chipBox!.width).toBeGreaterThan(180);
  expect(chipBox!.height).toBeLessThan(48);
  await expect(component.locator(".distribution-dialog-scroll")).toHaveCSS("overflow-y", "auto");
});