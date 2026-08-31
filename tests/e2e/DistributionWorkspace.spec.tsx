import { expect, test } from "@playwright/experimental-ct-react";

import { DistributionWorkspace } from "../../src/components/distribution";
import type {
  DistributionAnalysisConfigV1,
  DistributionResultEnvelopeV1,
  LoadedDistributionDocV1,
  PreservedDistributionDocV1,
} from "../../src/types/distribution";

const config: DistributionAnalysisConfigV1 = {
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
};

const item: LoadedDistributionDocV1 = {
  schemaVersion: "1",
  analysisId: "analysis-1",
  name: "Distribution 1",
  sourceDatasetId: "dataset-1",
  status: "ready",
  loadStatus: "ready",
  configRevision: 1,
  currentConfig: config,
};

const previousResult: DistributionResultEnvelopeV1 = {
  analysisId: item.analysisId,
  configRevision: 1,
  runId: "run-old",
  snapshotId: "snapshot-old",
  completedAt: "2026-08-26T00:00:00Z",
  reportBlocks: [{
    schemaVersion: "1",
    blockId: "summary",
    kind: "summary",
    titleKey: "distribution.summary",
    status: "ready",
    chartData: null,
  }],
};

test("renders the dormant empty-system statistical shell", async ({ mount }) => {
  const component = await mount(
    <DistributionWorkspace
      bootstrap={{
        schemaVersion: "1",
        mode: "emptySystem",
        canRun: false,
        datasetCount: 0,
        capabilities: [],
        observationPolicy: { schemaVersion: "1", dimensions: [] },
        resourceBudget: {
          maxGroups: 1000,
          maxRowsPerGroup: 100000,
          maxTotalRows: 1000000,
          maxTotalBytes: 67108864,
          cancelToken: null,
        },
      }}
      runState={null}
    />,
  );
  await expect(component.getByTestId("distribution-empty-system")).toBeVisible();
  await expect(component.getByTestId("distribution-capability-count")).toHaveText("0");
  await expect(component.getByTestId("distribution-results")).toBeEmpty();
  await expect(component.getByRole("button", { name: "Run" })).toBeDisabled();
  await expect(component.locator("canvas")).toHaveCount(0);
});

test("keeps the previous report visible while a newer run is updating", async ({ mount }) => {
  const component = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={{
        schemaVersion: "1",
        mode: "continuous",
        canRun: true,
        datasetCount: 1,
        capabilities: [{
          id: "distribution.summary.v1",
          titleKey: "distribution.summary",
          scope: "column",
          menuScope: "distribution",
          statusKey: "available",
        }],
        observationPolicy: { schemaVersion: "1", dimensions: [] },
        resourceBudget: {
          maxGroups: 1000,
          maxRowsPerGroup: 100000,
          maxTotalRows: 1000000,
          maxTotalBytes: 67108864,
          cancelToken: null,
        },
      }}
      runState={{
        analysisId: item.analysisId,
        configRevision: 1,
        runId: "run-new",
        status: "running",
        progress: null,
        snapshotId: "snapshot-new",
        cancelToken: "cancel-new",
      }}
      result={previousResult}
      failure={null}
    />,
  );

  await expect(component.getByTestId("distribution-workspace-state")).toHaveText("updating");
  await expect(component.getByTestId("distribution-report-block-summary")).toBeVisible();
  await expect(component.getByRole("button", { name: "Cancel" })).toBeEnabled();
});

test("renders missing source and preserved documents as non-runnable", async ({ mount }) => {
  const missing = await mount(
    <DistributionWorkspace
      item={{ ...item, loadStatus: "missingSource" }}
      sourceAvailable={false}
      bootstrap={null}
      runState={null}
      result={null}
      failure={null}
    />,
  );
  await expect(missing.getByTestId("distribution-workspace-state")).toHaveText("missing");
  await expect(missing.getByRole("button", { name: "Run" })).toBeDisabled();
  await missing.unmount();

  const preserved: PreservedDistributionDocV1 = {
    schemaVersion: "99",
    analysisId: "future-1",
    name: "Future Distribution",
    sourceDatasetId: "dataset-1",
    status: "unavailable",
    loadStatus: "unknownVersion",
    currentConfig: {},
    rawEnvelope: {},
  };
  const unknown = await mount(
    <DistributionWorkspace
      item={preserved}
      sourceAvailable
      bootstrap={null}
      runState={null}
      result={null}
      failure={null}
    />,
  );
  await expect(unknown.getByTestId("distribution-workspace-state")).toHaveText("unknown");
  await expect(unknown.getByTestId("distribution-edit-inputs")).toBeDisabled();
  await expect(unknown.getByTestId("distribution-workspace-run")).toBeDisabled();
});

test("renders cancelled, failed, and corrupt lifecycle states", async ({ mount }) => {
  const cancelled = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={{
        analysisId: item.analysisId,
        configRevision: 1,
        runId: "run-cancelled",
        status: "cancelled",
        progress: null,
        snapshotId: "snapshot-cancelled",
        cancelToken: "cancel-cancelled",
      }}
      result={null}
      failure={null}
    />,
  );
  await expect(cancelled.getByTestId("distribution-workspace-state")).toHaveText("cancelled");
  await cancelled.unmount();

  const stale = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={{
        analysisId: item.analysisId,
        configRevision: 1,
        runId: "run-stale",
        status: "stale",
        progress: null,
        snapshotId: "snapshot-stale",
        cancelToken: "cancel-stale",
      }}
      result={previousResult}
      failure={null}
    />,
  );
  await expect(stale.getByTestId("distribution-workspace-state")).toHaveText("stale");
  await expect(stale.getByTestId("distribution-report-block-summary")).toBeVisible();
  await stale.unmount();

  const failed = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={null}
      result={previousResult}
      failure={{
        analysisId: item.analysisId,
        configRevision: 1,
        runId: "run-failed",
        snapshotId: "snapshot-failed",
        code: "distribution.run.failed",
        messageKey: "distribution.run.failed",
      }}
    />,
  );
  await expect(failed.getByTestId("distribution-workspace-state")).toHaveText("failed");
  await expect(failed.getByTestId("distribution-report-block-summary")).toBeVisible();
  await failed.unmount();

  const corrupt = await mount(
    <DistributionWorkspace
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
      sourceAvailable
      runState={null}
      result={null}
      failure={null}
    />,
  );
  await expect(corrupt.getByTestId("distribution-workspace-state")).toHaveText("corrupt");
  await expect(corrupt.getByTestId("distribution-edit-inputs")).toBeDisabled();
});

test("renders ready and first-run running states", async ({ mount }) => {
  const ready = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={null}
      result={null}
      failure={null}
    />,
  );
  await expect(ready.getByTestId("distribution-workspace-state")).toHaveText("ready");
  await ready.unmount();

  const running = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={{
        analysisId: item.analysisId,
        configRevision: 1,
        runId: "run-first",
        status: "running",
        progress: null,
        snapshotId: "snapshot-first",
        cancelToken: "cancel-first",
      }}
      result={null}
      failure={null}
    />,
  );
  await expect(running.getByTestId("distribution-workspace-state")).toHaveText("running");
  await expect(running.getByRole("button", { name: "Cancel" })).toBeEnabled();
});

test("renders completed continuous summary values", async ({ mount }) => {
  const component = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      result={{
        ...previousResult,
        reportBlocks: [{
          schemaVersion: "1",
          blockId: "summary",
          kind: "summary",
          titleKey: "distribution.report.summary",
          status: "available",
          summaryData: {
            n: 5,
            nMissing: 1,
            mean: 3,
            stdDev: 1.58113883,
            stdError: 0.70710678,
            meanCiLower: 1.03675684,
            meanCiUpper: 4.96324316,
            minimum: 1,
            maximum: 5,
            median: 3,
            primaryMode: 1,
            range: 4,
            iqr: 3,
            mad: 1,
          },
          chartData: null,
        }],
      }}
    />,
  );

  await expect(component.getByText("Summary Statistics")).toBeVisible();
  await expect(component.getByText("3", { exact: true }).first()).toBeVisible();
});

test("renders a scrollable By and Y report hierarchy", async ({ mount, page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  const yResult = {
    yColumn: { columnId: "sales-id", modelingType: "continuous" as const },
    yName: "sales_amount",
    quantiles: [
      { probability: 0, value: 1 },
      { probability: 0.5, value: 3 },
      { probability: 1, value: 5 },
    ],
    blocks: [
      ...previousResult.reportBlocks,
      {
        schemaVersion: "1",
        blockId: "ecdf",
        kind: "ecdf",
        titleKey: "distribution.report.ecdf",
        status: "available",
        summaryData: null,
        capabilityData: null,
        chartData: {
          kind: "cdfData" as const,
          schemaVersion: "1",
          provenance: { methodId: "ecdf.weighted", snapshotId: "snapshot-1" },
          points: [{ x: 1, y: 0.5 }, { x: 2, y: 1 }],
        },
      },
    ],
  };
  const component = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      result={{
        ...previousResult,
        groups: [
          { groupKey: [], yResults: [yResult] },
          { groupKey: [{ kind: "text", value: "East" }], groupNames: ["region"], yResults: [yResult] },
          { groupKey: [{ kind: "text", value: "West" }], groupNames: ["region"], yResults: [yResult] },
          { groupKey: [{ kind: "missing" }], groupNames: ["region"], yResults: [yResult] },
        ],
      }}
    />,
  );

  await expect(component.getByRole("button", { name: "Overall" })).toHaveAttribute("aria-expanded", "true");
  await expect(component.getByRole("button", { name: "region = East" })).toHaveAttribute("aria-expanded", "false");
  await expect(component.getByRole("button", { name: /West/ })).toHaveAttribute("aria-expanded", "false");
  await expect(component.getByText("sales_amount").first()).toBeVisible();
  await expect(component.getByText("50%")).toBeVisible();
  await expect(component.getByText("Empirical CDF")).toHaveCount(0);
  await component.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await component.getByRole("checkbox", { name: "Empirical CDF" }).click();
  await expect(component.getByRole("button", { name: "Analysis options for sales_amount" }))
    .toHaveAttribute("aria-expanded", "false");
  await expect(component.getByRole("heading", { name: "Empirical CDF" })).toBeVisible();
  await component.getByRole("button", { name: /Missing/ }).click();
  const lastGroup = component.getByTestId("distribution-group-3");
  await lastGroup.scrollIntoViewIfNeeded();
  await expect(lastGroup).toBeVisible();
  await expect(component.getByTestId("distribution-report-scroll")).toHaveCSS("overflow-y", "auto");
});

test("normal quantile menu item depends on payload and chart stays hidden by default", async ({ mount }) => {
  const baseResult = {
    ...previousResult,
    groups: [{
      groupKey: [],
      yResults: [{
        yColumn: { columnId: "sales-id", modelingType: "continuous" as const },
        yName: "sales_amount",
        quantiles: [],
        blocks: [{
          schemaVersion: "1",
          blockId: "summary-only",
          kind: "summary",
          titleKey: "distribution.report.summary",
          status: "available",
          summaryData: {
            n: 3,
            nMissing: 0,
            mean: 2,
            stdDev: 1,
            stdError: 0.57735,
            meanCiLower: 0,
            meanCiUpper: 4,
            minimum: 1,
            maximum: 3,
            median: 2,
            primaryMode: 1,
            range: 2,
            iqr: 1,
            mad: 1,
          },
          chartData: null,
        }],
      }],
    }],
  };

  const withoutNormalQuantile = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      result={baseResult}
    />,
  );
  await withoutNormalQuantile.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await expect(withoutNormalQuantile.getByRole("checkbox", { name: "Normal Quantile Plot" })).toHaveCount(0);
  await withoutNormalQuantile.unmount();

  const withNormalQuantile = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      result={{
        ...baseResult,
        groups: [{
          groupKey: [],
          yResults: [{
            ...baseResult.groups![0].yResults[0],
            blocks: [
              ...baseResult.groups![0].yResults[0].blocks,
              {
                schemaVersion: "1",
                blockId: "normal-quantile-available",
                kind: "normalQuantile",
                titleKey: "distribution.report.normalQuantilePlot",
                status: "available",
                summaryData: null,
                capabilityData: null,
                chartData: {
                  kind: "normalQuantileData",
                  schemaVersion: "1",
                  provenance: {
                    methodId: "normalScore.documented.rankOverNPlus1",
                    methodVersion: "1.0.0",
                    compatibilityStatus: "documentedCompatible",
                    snapshotId: "snapshot-1",
                  },
                  payload: {
                    points: [
                      { rank: 1, probability: 0.25, normalScore: -0.6744897501960817, observedValue: -2 },
                      { rank: 2, probability: 0.5, normalScore: 0, observedValue: 0 },
                      { rank: 3, probability: 0.75, normalScore: 0.6744897501960817, observedValue: 3 },
                    ],
                    referenceLine: [
                      { x: -0.6744897501960817, y: -2 },
                      { x: 0.6744897501960817, y: 3 },
                    ],
                    confidenceBand: [
                      { x: -0.6744897501960817, lower: -2.5, upper: -1.5 },
                      { x: 0.6744897501960817, lower: 2.5, upper: 3.5 },
                    ],
                    status: "available",
                    reasonCode: null,
                    provenance: {
                      methodId: "normalScore.documented.rankOverNPlus1",
                      methodVersion: "1.0.0",
                      compatibilityStatus: "documentedCompatible",
                      snapshotId: "snapshot-1",
                    },
                    referenceLineProvenance: {
                      methodId: "normalQuantile.referenceLine.public.v1",
                      methodVersion: "1.0.0",
                      compatibilityStatus: "compatibilityPending",
                      snapshotId: "snapshot-1",
                    },
                    confidenceBandProvenance: {
                      methodId: "normalQuantile.pointwiseBand.public.v1",
                      methodVersion: "1.0.0",
                      compatibilityStatus: "compatibilityPending",
                      snapshotId: "snapshot-1",
                    },
                  },
                },
              },
            ],
          }],
        }],
      }}
    />,
  );

  await expect(withNormalQuantile.getByRole("heading", { name: "Normal Quantile Plot" })).toHaveCount(0);
  await withNormalQuantile.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await expect(withNormalQuantile.getByRole("checkbox", { name: "Normal Quantile Plot" })).toBeVisible();
  await withNormalQuantile.getByRole("checkbox", { name: "Normal Quantile Plot" }).click();
  await expect(withNormalQuantile.getByRole("heading", { name: "Normal Quantile Plot" })).toBeVisible();
});

test("quantile box and stem-and-leaf menu items are payload-gated and render on demand", async ({ mount }) => {
  const baseResult = {
    ...previousResult,
    groups: [{
      groupKey: [],
      yResults: [{
        yColumn: { columnId: "sales-id", modelingType: "continuous" as const },
        yName: "sales_amount",
        quantiles: [
          { probability: 0, value: 1 },
          { probability: 0.5, value: 3 },
          { probability: 1, value: 6 },
        ],
        blocks: [{
          schemaVersion: "1",
          blockId: "summary-only",
          kind: "summary",
          titleKey: "distribution.report.summary",
          status: "available",
          summaryData: {
            n: 6,
            nMissing: 0,
            mean: 3,
            stdDev: 1.87082869,
            stdError: 0.76376262,
            meanCiLower: 1.03675684,
            meanCiUpper: 4.96324316,
            minimum: 1,
            maximum: 6,
            median: 3,
            primaryMode: 1,
            range: 5,
            iqr: 3,
            mad: 1,
          },
          chartData: null,
        }],
      }],
    }],
  };

  const withoutPayload = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      result={baseResult}
    />,
  );

  await withoutPayload.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await expect(withoutPayload.getByRole("checkbox", { name: "Quantile Box Plot" })).toHaveCount(0);
  await expect(withoutPayload.getByRole("checkbox", { name: "Stem-and-Leaf" })).toHaveCount(0);
  await expect(withoutPayload.getByRole("heading", { name: "Quantile Box Plot" })).toHaveCount(0);
  await expect(withoutPayload.getByRole("heading", { name: "Stem-and-Leaf" })).toHaveCount(0);
  await withoutPayload.unmount();

  const withPayload = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      result={{
        ...baseResult,
        groups: [{
          groupKey: [],
          yResults: [{
            ...baseResult.groups![0].yResults[0],
            blocks: [
              ...baseResult.groups![0].yResults[0].blocks,
              {
                schemaVersion: "1",
                blockId: "quantile-box-available",
                kind: "quantileBox",
                titleKey: "distribution.report.quantileBoxPlot",
                status: "available",
                summaryData: null,
                capabilityData: null,
                chartData: {
                  kind: "quantileBoxData",
                  schemaVersion: "1",
                  provenance: {
                    methodId: "quantileBox.public.letterValue.type6.v1",
                    methodVersion: "1.0.0",
                    compatibilityStatus: "intentionalDifference",
                    snapshotId: "snapshot-1",
                  },
                  payload: {
                    layers: [
                      { probabilityLower: 0.25, probabilityUpper: 0.75, lower: 2, upper: 5, depth: 1 },
                      { probabilityLower: 0.125, probabilityUpper: 0.875, lower: 1.5, upper: 5.5, depth: 2 },
                    ],
                    median: 3,
                    status: "available",
                    reasonCode: null,
                    provenance: {
                      methodId: "quantileBox.public.letterValue.type6.v1",
                      methodVersion: "1.0.0",
                      compatibilityStatus: "intentionalDifference",
                      snapshotId: "snapshot-1",
                    },
                  },
                },
              },
              {
                schemaVersion: "1",
                blockId: "stem-and-leaf-available",
                kind: "stemAndLeaf",
                titleKey: "distribution.report.stemAndLeaf",
                status: "available",
                summaryData: null,
                capabilityData: null,
                chartData: null,
                stemAndLeafData: {
                  rows: [
                    { stem: "1", leaves: ["0", "2", "4"], omittedLeafCount: 1 },
                    { stem: "2", leaves: ["1", "3", "8"], omittedLeafCount: 2 },
                  ],
                  scale: 0.1,
                  omittedStemCount: 3,
                  omittedLeafCount: 12,
                  status: "available",
                  reasonCode: null,
                  provenance: {
                    methodId: "stemLeaf.public.splitScale.v1",
                    methodVersion: "1.0.0",
                    compatibilityStatus: "intentionalDifference",
                    snapshotId: "snapshot-1",
                  },
                },
              },
            ],
          }],
        }],
      }}
    />,
  );

  await expect(withPayload.getByRole("heading", { name: "Quantile Box Plot" })).toHaveCount(0);
  await expect(withPayload.getByRole("heading", { name: "Stem-and-Leaf" })).toHaveCount(0);

  await withPayload.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await expect(withPayload.getByRole("checkbox", { name: "Quantile Box Plot" })).toBeVisible();
  await expect(withPayload.getByRole("checkbox", { name: "Stem-and-Leaf" })).toBeVisible();
  await withPayload.getByRole("checkbox", { name: "Quantile Box Plot" }).click();

  await expect(withPayload.getByRole("heading", { name: "Quantile Box Plot" })).toBeVisible();
  await expect(withPayload.getByText("Public method; differs from JMP 19").first()).toBeVisible();
  await expect(withPayload.locator('[data-chart-kind="quantileBoxData"] canvas')).toHaveCount(1);

  await withPayload.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await withPayload.getByRole("checkbox", { name: "Stem-and-Leaf" }).click();

  await expect(withPayload.getByRole("heading", { name: "Stem-and-Leaf" })).toBeVisible();
  await expect(withPayload.getByText("Public method; differs from JMP 19").nth(1)).toBeVisible();
  const stemTable = withPayload.getByRole("table", { name: "Stem-and-Leaf" });
  await expect(stemTable).toBeVisible();
  await expect(stemTable.locator("tbody tr")).toHaveCount(2);
  await expect(stemTable.locator("tbody tr").nth(0).locator("td").nth(1)).toHaveText("1");
  await expect(stemTable.locator("tbody tr").nth(1).locator("td").nth(1)).toHaveText("2");
  await expect(stemTable.locator("tbody td").first()).toHaveCSS("border-right-style", "solid");
  await expect(stemTable.locator("tbody td").first()).toHaveCSS("border-bottom-style", "solid");
  await expect(withPayload.getByText("Scale: 0.1")).toBeVisible();
  await expect(withPayload.getByText("Omitted stems: 3")).toBeVisible();
  await expect(withPayload.getByText("Omitted leaves: 12")).toBeVisible();
});

test("shows unavailable reason for stem-and-leaf blocks", async ({ mount }) => {
  const component = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      result={{
        ...previousResult,
        groups: [{
          groupKey: [],
          yResults: [{
            yColumn: { columnId: "sales-id", modelingType: "continuous" as const },
            yName: "sales_amount",
            quantiles: [],
            blocks: [{
              schemaVersion: "1",
              blockId: "stem-and-leaf-unavailable",
              kind: "stemAndLeaf",
              titleKey: "distribution.report.stemAndLeaf",
              status: "unavailable",
              summaryData: null,
              capabilityData: null,
              chartData: null,
              stemAndLeafData: {
                rows: [
                  { stem: "1", leaves: [], omittedLeafCount: 0 },
                  { stem: "2", leaves: [], omittedLeafCount: 0 },
                ],
                scale: 1,
                omittedStemCount: 0,
                omittedLeafCount: 0,
                status: "unavailable",
                reasonCode: "stemLeaf.jmp19.pending.extremescale",
                provenance: {
                  methodId: "stemLeaf.jmp19.scaleSplit",
                  methodVersion: "1.0.0",
                  compatibilityStatus: "compatibilityPending",
                  snapshotId: "snapshot-1",
                },
              },
            }],
          }],
        }],
      }}
    />,
  );

  await component.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await component.getByRole("checkbox", { name: "Stem-and-Leaf" }).click();
  await expect(component.getByText("Unavailable: stemLeaf.jmp19.pending.extremescale")).toBeVisible();
});

test("restores and writes report display preferences without rerunning", async ({ mount }) => {
  let updatedPreferences: unknown = null;
  const preferenceItem: LoadedDistributionDocV1 = {
    ...item,
    currentConfig: {
      ...config,
      reportPreferences: {
        "sales-id": {
          overview: true,
          quantiles: true,
          summary: true,
          ecdf: true,
          processCapability: true,
          capabilityHistogram: true,
          capabilityProcessSummary: true,
          capabilityWithin: true,
          capabilityOverall: true,
          capabilityNonconformance: true,
        },
      },
    },
  };
  const component = await mount(
    <DistributionWorkspace
      item={preferenceItem}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      onReportPreferencesChange={(_columnId, preferences) => { updatedPreferences = preferences; }}
      result={{
        ...previousResult,
        groups: [{
          groupKey: [],
          yResults: [{
            yColumn: { columnId: "sales-id", modelingType: "continuous" },
            yName: "sales_amount",
            quantiles: [],
            blocks: [
              ...previousResult.reportBlocks,
              {
                schemaVersion: "1",
                blockId: "ecdf-saved",
                kind: "ecdf",
                titleKey: "distribution.report.ecdf",
                status: "available",
                chartData: {
                  kind: "cdfData",
                  schemaVersion: "1",
                  provenance: { methodId: "ecdf.weighted", snapshotId: "snapshot-old" },
                  points: [{ x: 1, y: 1 }],
                },
              },
            ],
          }],
        }],
      }}
    />,
  );

  await expect(component.getByRole("heading", { name: "Empirical CDF" })).toBeVisible();
  await component.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await component.getByRole("checkbox", { name: "Summary Statistics" }).click();
  expect(updatedPreferences).toMatchObject({ ecdf: true, summary: false });
});

for (const [confidenceLevel, confidencePercent] of [[0.95, 95], [0.9, 90]] as const) {
test(`renders automatic Process Capability with ${confidencePercent}% interval headers`, async ({ mount }) => {
  const capabilityValue = (value: number) => ({ state: "available" as const, value, reasonCode: null });
  const capabilityInterval = (lower: number, upper: number) => ({
    lower: capabilityValue(lower),
    upper: capabilityValue(upper),
    intervalMethod: "wald.v1",
    limitingSide: null,
    warnings: [],
  });
  const observedTail = (count: number, proportion: number) => ({
    count: { state: "available" as const, value: count, reasonCode: null },
    proportion: capabilityValue(proportion),
    ppm: capabilityValue(proportion * 1_000_000),
    proportionInterval: {
      lower: capabilityValue(0), upper: capabilityValue(0.1), intervalMethod: "wilson.v1",
    },
  });
  const expectedTail = (proportion: number) => ({
    proportion: capabilityValue(proportion), ppm: capabilityValue(proportion * 1_000_000),
  });
  const component = await mount(
    <DistributionWorkspace
      item={{
        ...item,
        currentConfig: {
          ...config,
          reportPreferences: {
            "sales-id": {
              overview: true,
              histogram: true,
              outlierBoxPlot: true,
              specificationLines: true,
              quantiles: true,
              summary: true,
              horizontalTables: true,
              normalQuantilePlot: false,
              quantileBoxPlot: false,
              stemAndLeaf: false,
              ecdf: false,
              processCapability: true,
              histogramScale: "count",
            },
          },
        },
      }}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      result={{
        ...previousResult,
        groups: [{
          groupKey: [],
          yResults: [{
            yColumn: { columnId: "sales-id", modelingType: "continuous" },
            yName: "sales_amount",
            quantiles: [],
            blocks: [{
              schemaVersion: "1",
              blockId: "capability",
              kind: "processCapability",
              titleKey: "distribution.report.processCapability",
              status: "available",
              capabilityData: {
                specification: { lsl: 1000, target: 2000, usl: 3000, source: "columnProperty" },
                processSummary: {
                  n: 51,
                  mean: 523.7239,
                  movingRangeAverage: 677.1,
                  d2: 1.128379,
                  withinSigma: 600.4645,
                  overallSigma: 731.7753,
                },
                indices: {
                  cp: capabilityValue(0.555), cpk: capabilityValue(-0.264),
                  cpl: capabilityValue(-0.264), cpu: capabilityValue(1.375),
                  cpmWithin: capabilityValue(0.209), pp: capabilityValue(0.456),
                  ppk: capabilityValue(-0.217), ppl: capabilityValue(-0.217),
                  ppu: capabilityValue(1.128), cpmOverall: capabilityValue(0.202),
                },
                intervals: {
                  confidenceLevel,
                  cp: capabilityInterval(0.4, 0.7), cpk: capabilityInterval(-0.4, -0.1),
                  cpl: capabilityInterval(-0.4, -0.1), cpu: capabilityInterval(1.0, 1.7),
                  cpmWithin: capabilityInterval(0.1, 0.3), pp: capabilityInterval(0.3, 0.6),
                  ppk: capabilityInterval(-0.3, -0.1), ppl: capabilityInterval(-0.3, -0.1),
                  ppu: capabilityInterval(0.8, 1.4), cpmOverall: capabilityInterval(0.1, 0.3),
                  provenance: {
                    distributionCrate: "statrs", distributionCrateVersion: "0.18.0",
                    parameterization: "standardNormal(0,1)",
                    inverseCdfAlgorithmId: "statrs.inverseCdf.v1", methodVersion: "1.0.0",
                    withinEffectiveDegreesOfFreedom: 30.43832706934947,
                  },
                },
                nonconformance: {
                  observed: {
                    below: observedTail(3, 3 / 51), above: observedTail(0, 0), total: observedTail(3, 3 / 51),
                  },
                  expectedWithin: {
                    below: expectedTail(0.01), above: expectedTail(0.0001), total: expectedTail(0.0101),
                  },
                  expectedOverall: {
                    below: expectedTail(0.02), above: expectedTail(0.001), total: expectedTail(0.021),
                  },
                },
                warnings: [],
              },
              chartData: null,
            }],
          }],
        }],
      }}
    />,
  );

  await expect(component.getByText("Process Capability")).toBeVisible();
  await expect(component.getByText("Specification Limits")).toBeVisible();
  await expect(component.getByText("Within Sigma Capability")).toBeVisible();
  await expect(component.getByText("Overall Sigma Capability")).toBeVisible();
  await expect(component.getByText("Nonconformance")).toBeVisible();
  await expect(component.getByRole("columnheader", { name: `Lower ${confidencePercent}%` }).first()).toBeVisible();
  await expect(component.getByRole("columnheader", { name: `Upper ${confidencePercent}%` }).first()).toBeVisible();
  await expect(component.getByRole("columnheader", { name: "Lower CI" })).toHaveCount(0);
  await expect(component.getByRole("columnheader", { name: "Upper CI" })).toHaveCount(0);
  await component.getByRole("button", { name: "Process Capability options" }).click();
  await expect(component.getByRole("region", { name: "Process Capability options" })).toBeVisible();
  await component.getByRole("checkbox", { name: "Nonconformance" }).click();
  await expect(component.getByText("Nonconformance")).toHaveCount(0);
  await expect(component.getByText("1,000")).toBeVisible();
});
}

test("groups Y menu options and closes on Escape with focus restored", async ({ mount, page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  let editInputsCalls = 0;
  const fitChanges: Array<{ enabledDistributionIds: string[]; fitAll: boolean }> = [];
  const component = await mount(
    <DistributionWorkspace
      item={{
        ...item,
        currentConfig: {
          ...config,
          visualDiagnostics: {
            histogram: {
              method: "scott",
              fixedCount: null,
              fixedWidth: null,
            },
            normalQuantileConfidenceLevel: 0.95,
          },
          continuousFit: {
            enabledDistributionIds: ["normal"],
            fitAll: false,
            diagnostics: { goodnessOfFit: false, qqPlot: false, cdfPlot: false, ppPlot: false },
          },
          reportPreferences: {
            "sales-id": {
              overview: true,
              histogram: true,
              outlierBoxPlot: true,
              specificationLines: true,
              quantiles: true,
              summary: true,
              horizontalTables: true,
              normalQuantilePlot: false,
              quantileBoxPlot: false,
              stemAndLeaf: false,
              ecdf: false,
              processCapability: true,
              histogramScale: "count",
            },
          },
        },
      }}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      onEditInputs={() => {
        editInputsCalls += 1;
      }}
      onContinuousFitChange={(continuousFit) => {
        fitChanges.push(continuousFit);
      }}
      bootstrap={{
        schemaVersion: "1",
        mode: "continuous",
        canRun: true,
        datasetCount: 1,
        capabilities: ["normal", "lognormal", "exponential", "gamma", "weibull"].map((id) => ({
          id: `fit.continuous.${id}`,
          titleKey: `distribution.capability.fit.continuous.${id}`,
          scope: "continuousY",
          menuScope: "distribution",
          statusKey: "distribution.capability.available",
        })),
        observationPolicy: { schemaVersion: "1", dimensions: [] },
        resourceBudget: {
          maxGroups: 100,
          maxRowsPerGroup: 1000,
          maxTotalRows: 1000,
          maxTotalBytes: 1024,
          cancelToken: null,
        },
      }}
      result={{
        ...previousResult,
        groups: [{
          groupKey: [],
          yResults: [{
            yColumn: { columnId: "sales-id", modelingType: "continuous" },
            yName: "sales_amount",
            quantiles: [{ probability: 0.5, value: 3 }],
            blocks: [
              {
                schemaVersion: "1",
                blockId: "hist",
                kind: "histogram",
                titleKey: "distribution.report.histogram",
                status: "available",
                summaryData: null,
                capabilityData: null,
                chartData: {
                  kind: "histogramData",
                  schemaVersion: "1",
                  provenance: {
                    methodId: "hist.public.scott",
                    methodVersion: "1.0.0",
                    compatibilityStatus: "documentedCompatible",
                    snapshotId: "snapshot-1",
                  },
                  bins: [{ lower: 1, upper: 2, count: 3, probability: 1, density: 1 }],
                },
              },
              {
                schemaVersion: "1",
                blockId: "box",
                kind: "boxPlot",
                titleKey: "distribution.report.boxPlot",
                status: "available",
                summaryData: null,
                capabilityData: null,
                chartData: {
                  kind: "boxPlotData",
                  schemaVersion: "1",
                  provenance: {
                    methodId: "box.public.v1",
                    methodVersion: "1.0.0",
                    compatibilityStatus: "documentedCompatible",
                    snapshotId: "snapshot-1",
                  },
                  coordinates: {
                    lowerWhisker: 1,
                    lowerQuartile: 2,
                    median: 3,
                    upperQuartile: 4,
                    upperWhisker: 5,
                    outliers: [7],
                  },
                },
              },
              {
                schemaVersion: "1",
                blockId: "summary",
                kind: "summary",
                titleKey: "distribution.report.summary",
                status: "available",
                chartData: null,
                summaryData: {
                  n: 5,
                  nMissing: 0,
                  mean: 3,
                  stdDev: 1,
                  stdError: 0.5,
                  meanCiLower: 2,
                  meanCiUpper: 4,
                  minimum: 1,
                  maximum: 5,
                  median: 3,
                  primaryMode: 1,
                  range: 4,
                  iqr: 2,
                  mad: 1,
                },
                capabilityData: null,
              },
              {
                schemaVersion: "1",
                blockId: "normal-quantile",
                kind: "normalQuantile",
                titleKey: "distribution.report.normalQuantilePlot",
                status: "available",
                summaryData: null,
                capabilityData: null,
                chartData: {
                  kind: "normalQuantileData",
                  schemaVersion: "1",
                  provenance: {
                    methodId: "normalScore.documented.rankOverNPlus1",
                    methodVersion: "1.0.0",
                    compatibilityStatus: "documentedCompatible",
                    snapshotId: "snapshot-1",
                  },
                  payload: {
                    points: [{ rank: 1, probability: 0.5, normalScore: 0, observedValue: 3 }],
                    referenceLine: [{ x: 0, y: 3 }],
                    confidenceBand: [{ x: 0, lower: 2.9, upper: 3.1 }],
                    status: "available",
                    reasonCode: null,
                    provenance: {
                      methodId: "normalScore.documented.rankOverNPlus1",
                      methodVersion: "1.0.0",
                      compatibilityStatus: "documentedCompatible",
                      snapshotId: "snapshot-1",
                    },
                    referenceLineProvenance: {
                      methodId: "normalQuantile.referenceLine.public.v1",
                      methodVersion: "1.0.0",
                      compatibilityStatus: "compatibilityPending",
                      snapshotId: "snapshot-1",
                    },
                    confidenceBandProvenance: {
                      methodId: "normalQuantile.pointwiseBand.public.v1",
                      methodVersion: "1.0.0",
                      compatibilityStatus: "compatibilityPending",
                      snapshotId: "snapshot-1",
                    },
                  },
                },
              },
              {
                schemaVersion: "1",
                blockId: "capability",
                kind: "processCapability",
                titleKey: "distribution.report.processCapability",
                status: "available",
                summaryData: null,
                chartData: null,
                capabilityData: {
                  specification: { lsl: 0, target: 3, usl: 10, source: "columnProperty" },
                  processSummary: {
                    n: 5,
                    mean: 3,
                    movingRangeAverage: 1,
                    d2: 1.128379,
                    withinSigma: 0.8,
                    overallSigma: 1,
                  },
                  indices: {
                    cp: { state: "available", value: 1, reasonCode: null },
                    cpk: { state: "available", value: 1, reasonCode: null },
                    cpl: { state: "available", value: 1, reasonCode: null },
                    cpu: { state: "available", value: 1, reasonCode: null },
                    cpmWithin: { state: "available", value: 1, reasonCode: null },
                    pp: { state: "available", value: 1, reasonCode: null },
                    ppk: { state: "available", value: 1, reasonCode: null },
                    ppl: { state: "available", value: 1, reasonCode: null },
                    ppu: { state: "available", value: 1, reasonCode: null },
                    cpmOverall: { state: "available", value: 1, reasonCode: null },
                  },
                  intervals: {
                    confidenceLevel: 0.95,
                    cp: { lower: { state: "available", value: 0.9, reasonCode: null }, upper: { state: "available", value: 1.1, reasonCode: null }, intervalMethod: "wald", limitingSide: null, warnings: [] },
                    cpk: { lower: { state: "available", value: 0.9, reasonCode: null }, upper: { state: "available", value: 1.1, reasonCode: null }, intervalMethod: "wald", limitingSide: null, warnings: [] },
                    cpl: { lower: { state: "available", value: 0.9, reasonCode: null }, upper: { state: "available", value: 1.1, reasonCode: null }, intervalMethod: "wald", limitingSide: null, warnings: [] },
                    cpu: { lower: { state: "available", value: 0.9, reasonCode: null }, upper: { state: "available", value: 1.1, reasonCode: null }, intervalMethod: "wald", limitingSide: null, warnings: [] },
                    cpmWithin: { lower: { state: "available", value: 0.9, reasonCode: null }, upper: { state: "available", value: 1.1, reasonCode: null }, intervalMethod: "wald", limitingSide: null, warnings: [] },
                    pp: { lower: { state: "available", value: 0.9, reasonCode: null }, upper: { state: "available", value: 1.1, reasonCode: null }, intervalMethod: "wald", limitingSide: null, warnings: [] },
                    ppk: { lower: { state: "available", value: 0.9, reasonCode: null }, upper: { state: "available", value: 1.1, reasonCode: null }, intervalMethod: "wald", limitingSide: null, warnings: [] },
                    ppl: { lower: { state: "available", value: 0.9, reasonCode: null }, upper: { state: "available", value: 1.1, reasonCode: null }, intervalMethod: "wald", limitingSide: null, warnings: [] },
                    ppu: { lower: { state: "available", value: 0.9, reasonCode: null }, upper: { state: "available", value: 1.1, reasonCode: null }, intervalMethod: "wald", limitingSide: null, warnings: [] },
                    cpmOverall: { lower: { state: "available", value: 0.9, reasonCode: null }, upper: { state: "available", value: 1.1, reasonCode: null }, intervalMethod: "wald", limitingSide: null, warnings: [] },
                    provenance: {
                      distributionCrate: "statrs",
                      distributionCrateVersion: "0.18.0",
                      parameterization: "standardNormal(0,1)",
                      inverseCdfAlgorithmId: "statrs.inverseCdf.v1",
                      methodVersion: "1.0.0",
                      withinEffectiveDegreesOfFreedom: 2.5,
                    },
                  },
                  nonconformance: {
                    observed: {
                      below: {
                        count: { state: "available", value: 1, reasonCode: null },
                        proportion: { state: "available", value: 0.2, reasonCode: null },
                        ppm: { state: "available", value: 200000, reasonCode: null },
                        proportionInterval: {
                          lower: { state: "available", value: 0.1, reasonCode: null },
                          upper: { state: "available", value: 0.3, reasonCode: null },
                          intervalMethod: "wilson.v1",
                        },
                      },
                      above: {
                        count: { state: "available", value: 0, reasonCode: null },
                        proportion: { state: "available", value: 0, reasonCode: null },
                        ppm: { state: "available", value: 0, reasonCode: null },
                        proportionInterval: {
                          lower: { state: "available", value: 0, reasonCode: null },
                          upper: { state: "available", value: 0.05, reasonCode: null },
                          intervalMethod: "wilson.v1",
                        },
                      },
                      total: {
                        count: { state: "available", value: 1, reasonCode: null },
                        proportion: { state: "available", value: 0.2, reasonCode: null },
                        ppm: { state: "available", value: 200000, reasonCode: null },
                        proportionInterval: {
                          lower: { state: "available", value: 0.1, reasonCode: null },
                          upper: { state: "available", value: 0.3, reasonCode: null },
                          intervalMethod: "wilson.v1",
                        },
                      },
                    },
                    expectedWithin: {
                      below: { proportion: { state: "available", value: 0.01, reasonCode: null }, ppm: { state: "available", value: 10000, reasonCode: null } },
                      above: { proportion: { state: "available", value: 0.02, reasonCode: null }, ppm: { state: "available", value: 20000, reasonCode: null } },
                      total: { proportion: { state: "available", value: 0.03, reasonCode: null }, ppm: { state: "available", value: 30000, reasonCode: null } },
                    },
                    expectedOverall: {
                      below: { proportion: { state: "available", value: 0.015, reasonCode: null }, ppm: { state: "available", value: 15000, reasonCode: null } },
                      above: { proportion: { state: "available", value: 0.025, reasonCode: null }, ppm: { state: "available", value: 25000, reasonCode: null } },
                      total: { proportion: { state: "available", value: 0.04, reasonCode: null }, ppm: { state: "available", value: 40000, reasonCode: null } },
                    },
                  },
                  warnings: [],
                },
              },
            ],
          }],
        }],
      }}
    />,
  );

  const trigger = component.getByRole("button", { name: "Analysis options for sales_amount" });
  await trigger.click();
  await expect(component.getByRole("group", { name: "Display" })).toBeVisible();
  await expect(component.getByRole("group", { name: "Histogram" })).toBeVisible();
  await expect(component.getByRole("group", { name: "Diagnostic Plots" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Process Capability" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Fit Normal" })).toBeChecked();
  await expect(component.getByRole("checkbox", { name: "Fit Lognormal" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Fit Exponential" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Fit Gamma" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Fit Weibull" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Fit All" })).toBeVisible();
  await expect(component.getByText("Fit Cauchy", { exact: true })).toHaveCount(0);
  await expect(component.getByText("Fit Student's t", { exact: true })).toHaveCount(0);
  await component.getByRole("checkbox", { name: "Fit Gamma" }).click();
  expect(fitChanges).toHaveLength(1);
  expect(fitChanges[0]).toMatchObject({ enabledDistributionIds: ["normal", "gamma"], fitAll: false });

  await trigger.click();
  await component.getByRole("checkbox", { name: "Fit All" }).click();
  expect(fitChanges).toHaveLength(2);
  expect(fitChanges[1]).toMatchObject({ enabledDistributionIds: [], fitAll: true });
  await trigger.click();
  await expect(component.getByRole("checkbox", { name: "Overview" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Horizontal Tables" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Histogram" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Outlier Box Plot" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Specification Lines" })).toBeVisible();
  await expect(component.getByRole("radio", { name: "Count" })).toHaveCount(0);
  await expect(component.getByRole("radio", { name: "Probability" })).toHaveCount(0);
  await expect(component.getByRole("radio", { name: "Density" })).toHaveCount(0);
  await expect(component.getByText("Scale: Probability Density")).toBeVisible();
  const optionsPanelStyle = await component
    .getByRole("region", { name: "Analysis options for sales_amount" })
    .evaluate((element) => getComputedStyle(element));
  expect(optionsPanelStyle.backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  expect(optionsPanelStyle.overflowY).toBe("auto");
  expect(Number(optionsPanelStyle.zIndex)).toBeGreaterThanOrEqual(100);
  await expect(component.getByText("Current method: Scott")).toBeVisible();
  await component.locator(".distribution-analysis-menu .distribution-menu-action").click();
  expect(editInputsCalls).toBe(1);

  await trigger.click();
  const optionsPanel = component.getByRole("region", { name: "Analysis options for sales_amount" });
  await expect(optionsPanel.getByText("Test Mean", { exact: true })).toHaveCount(0);
  await expect(optionsPanel.getByText("Continuous Fit", { exact: true })).toBeVisible();
  await expect(optionsPanel.getByText("Save", { exact: true })).toHaveCount(0);
  await page.keyboard.press("Escape");
  await expect(trigger).toHaveAttribute("aria-expanded", "false");
  await expect(trigger).toBeFocused();
});

test("renders overview according to independent histogram and outlier box toggles", async ({ mount }) => {
  const component = await mount(
    <DistributionWorkspace
      item={{
        ...item,
        currentConfig: {
          ...config,
          reportPreferences: {
            "sales-id": {
              overview: true,
              histogram: true,
              outlierBoxPlot: true,
              specificationLines: true,
              quantiles: false,
              summary: false,
              horizontalTables: true,
              normalQuantilePlot: false,
              quantileBoxPlot: false,
              stemAndLeaf: false,
              ecdf: false,
              processCapability: false,
              histogramScale: "count",
            },
          },
        },
      }}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      result={{
        ...previousResult,
        groups: [{
          groupKey: [],
          yResults: [{
            yColumn: { columnId: "sales-id", modelingType: "continuous" },
            yName: "sales_amount",
            quantiles: [],
            blocks: [
              {
                schemaVersion: "1",
                blockId: "hist",
                kind: "histogram",
                titleKey: "distribution.report.histogram",
                status: "available",
                summaryData: null,
                capabilityData: null,
                chartData: {
                  kind: "histogramData",
                  schemaVersion: "1",
                  provenance: {
                    methodId: "hist.public.scott",
                    methodVersion: "1.0.0",
                    compatibilityStatus: "documentedCompatible",
                    snapshotId: "snapshot-1",
                  },
                  bins: [{ lower: 1, upper: 2, count: 3, probability: 1, density: 1 }],
                },
              },
              {
                schemaVersion: "1",
                blockId: "box",
                kind: "boxPlot",
                titleKey: "distribution.report.boxPlot",
                status: "available",
                summaryData: null,
                capabilityData: null,
                chartData: {
                  kind: "boxPlotData",
                  schemaVersion: "1",
                  provenance: {
                    methodId: "box.public.v1",
                    methodVersion: "1.0.0",
                    compatibilityStatus: "documentedCompatible",
                    snapshotId: "snapshot-1",
                  },
                  coordinates: {
                    lowerWhisker: 1,
                    lowerQuartile: 2,
                    median: 3,
                    upperQuartile: 4,
                    upperWhisker: 5,
                    outliers: [7],
                  },
                },
              },
            ],
          }],
        }],
      }}
    />,
  );

  await expect(component.locator('[data-chart-kind="overview"]')).toHaveCount(1);
  await component.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await component.getByRole("checkbox", { name: "Outlier Box Plot" }).click();
  await expect(component.locator('[data-chart-kind="overview"]')).toHaveCount(1);
  await expect(component.locator('[data-chart-kind="histogramData"]')).toHaveCount(0);

  await component.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await component.getByRole("checkbox", { name: "Histogram" }).click();
  await component.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await component.getByRole("checkbox", { name: "Outlier Box Plot" }).click();
  await expect(component.locator('[data-chart-kind="histogramData"]')).toHaveCount(0);
  await expect(component.locator('[data-chart-kind="boxPlotData"]')).toHaveCount(1);

  await component.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await component.getByRole("checkbox", { name: "Outlier Box Plot" }).click();
  await expect(component.locator('[data-chart-kind="boxPlotData"]')).toHaveCount(0);
  await expect(component.locator('[data-chart-kind="overview"]')).toHaveCount(0);
});

test("renders quantiles and summary in .distribution-table-pair with responsive layout and visible borders", async ({ mount, page }) => {
  await page.setViewportSize({ width: 1024, height: 700 });
  const component = await mount(
    <DistributionWorkspace
      item={{
        ...item,
        currentConfig: {
          ...config,
          reportPreferences: {
            "sales-id": {
              overview: false,
              histogram: true,
              outlierBoxPlot: true,
              specificationLines: true,
              quantiles: true,
              summary: true,
              horizontalTables: true,
              normalQuantilePlot: false,
              quantileBoxPlot: false,
              stemAndLeaf: false,
              ecdf: false,
              processCapability: false,
              histogramScale: "count",
            },
          },
        },
      }}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      result={{
        ...previousResult,
        groups: [{
          groupKey: [],
          yResults: [{
            yColumn: { columnId: "sales-id", modelingType: "continuous" },
            yName: "sales_amount",
            quantiles: [
              { probability: 0, value: 1 },
              { probability: 0.5, value: 3 },
              { probability: 1, value: 5 },
            ],
            blocks: [{
              schemaVersion: "1",
              blockId: "summary",
              kind: "summary",
              titleKey: "distribution.report.summary",
              status: "available",
              chartData: null,
              summaryData: {
                n: 5,
                nMissing: 0,
                mean: 3,
                stdDev: 1,
                stdError: 0.5,
                meanCiLower: 2,
                meanCiUpper: 4,
                minimum: 1,
                maximum: 5,
                median: 3,
                primaryMode: 1,
                range: 4,
                iqr: 2,
                mad: 1,
              },
              capabilityData: null,
            }],
          }],
        }],
      }}
    />,
  );

  const pair = component.locator(".distribution-table-pair");
  await expect(pair).toHaveCount(1);
  await expect(component.getByRole("heading", { name: "Summary Statistics" })).toHaveCount(1);
  await expect(component.getByRole("heading", { name: "Quantiles" })).toHaveCount(1);

  const quantilesTable = component.locator(".distribution-table-pair .distribution-quantile-table");
  const summaryTable = component.locator(".distribution-table-pair .distribution-summary-table").first();
  const quantilesBox = await quantilesTable.boundingBox();
  const summaryBox = await summaryTable.boundingBox();
  expect(quantilesBox).not.toBeNull();
  expect(summaryBox).not.toBeNull();
  if (!quantilesBox || !summaryBox) return;
  expect(Math.abs(quantilesBox.y - summaryBox.y)).toBeLessThan(3);
  expect(Math.abs(quantilesBox.x - summaryBox.x)).toBeGreaterThan(40);

  await expect(quantilesTable.locator("tbody tr").first().locator("td").first()).toHaveCSS("border-right-style", "solid");
  await expect(quantilesTable.locator("tbody tr").first().locator("td").last()).toHaveCSS("border-right-style", "solid");
  await expect(quantilesTable.locator("tbody tr").first().locator("td").first()).toHaveCSS("border-bottom-style", "solid");

  await page.setViewportSize({ width: 768, height: 900 });
  const quantilesNarrowBox = await quantilesTable.boundingBox();
  const summaryNarrowBox = await summaryTable.boundingBox();
  expect(quantilesNarrowBox).not.toBeNull();
  expect(summaryNarrowBox).not.toBeNull();
  if (!quantilesNarrowBox || !summaryNarrowBox) return;
  expect(Math.abs(quantilesNarrowBox.x - summaryNarrowBox.x)).toBeLessThan(3);
  expect(summaryNarrowBox.y).toBeGreaterThan(quantilesNarrowBox.y + 20);

  await component.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await component.getByRole("checkbox", { name: "Horizontal Tables" }).click();
  const quantilesVerticalBox = await quantilesTable.boundingBox();
  const summaryVerticalBox = await summaryTable.boundingBox();
  expect(quantilesVerticalBox).not.toBeNull();
  expect(summaryVerticalBox).not.toBeNull();
  if (!quantilesVerticalBox || !summaryVerticalBox) return;
  expect(Math.abs(quantilesVerticalBox.x - summaryVerticalBox.x)).toBeLessThan(3);
});

for (const viewport of [
  { width: 1440, height: 900 },
  { width: 1024, height: 700 },
  { width: 768, height: 900 },
]) {
  test(`keeps aligned report bounds without overflow at ${viewport.width}x${viewport.height}`, async ({ mount, page }) => {
    await page.setViewportSize(viewport);
    const component = await mount(
      <div className="distribution-y-content" style={{ width: "100%" }}>
        <section className="distribution-report-block" data-testid="bounds-overview">
          <div className="distribution-chart" />
        </section>
        <section className="distribution-report-block" data-testid="bounds-fit-density">
          <div className="distribution-chart" />
        </section>
        <section className="distribution-report-block distribution-table-pair" data-testid="bounds-tables">
          <table className="distribution-quantile-table"><tbody><tr><td>0.5</td><td>Median</td><td>3</td></tr></tbody></table>
          <table className="distribution-summary-table"><tbody><tr><th>Mean</th><td>3</td></tr></tbody></table>
        </section>
        <section className="distribution-report-block" data-testid="bounds-capability">
          <div className="distribution-capability-report">
            <div className="distribution-capability-summary">
              <table><tbody><tr><th>LSL</th><td>0</td></tr></tbody></table>
              <table><tbody><tr><th>Mean</th><td>3</td></tr></tbody></table>
            </div>
          </div>
        </section>
        <section className="distribution-report-block" data-testid="bounds-fit-comparison">
          <table className="distribution-fit-table distribution-fit-comparison"><tbody><tr><th>Normal</th><td>12</td></tr></tbody></table>
        </section>
      </div>,
    );

    const reference = await component.getByTestId("bounds-overview").boundingBox();
    expect(reference).not.toBeNull();
    if (!reference) return;
    const referenceRight = reference.x + reference.width;
    for (const testId of ["bounds-fit-density", "bounds-tables", "bounds-capability", "bounds-fit-comparison"]) {
      const surface = await component.getByTestId(testId).boundingBox();
      expect(surface).not.toBeNull();
      if (!surface) continue;
      expect(Math.abs(surface.x - reference.x)).toBeLessThanOrEqual(2);
      expect(Math.abs(surface.x + surface.width - referenceRight)).toBeLessThanOrEqual(2);
    }

    const hasOverflow = await component.evaluate((root) => root.scrollWidth > root.clientWidth + 1);
    expect(hasOverflow).toBe(false);
    const pairedTables = component.getByTestId("bounds-tables").locator("table");
    const pairedCapability = component.getByTestId("bounds-capability").locator("table");
    const tableBoxes = await Promise.all([pairedTables.nth(0).boundingBox(), pairedTables.nth(1).boundingBox()]);
    const capabilityBoxes = await Promise.all([pairedCapability.nth(0).boundingBox(), pairedCapability.nth(1).boundingBox()]);
    if (viewport.width > 900) {
      expect(Math.abs((tableBoxes[0]?.y ?? 0) - (tableBoxes[1]?.y ?? 0))).toBeLessThanOrEqual(3);
      expect(Math.abs((capabilityBoxes[0]?.y ?? 0) - (capabilityBoxes[1]?.y ?? 0))).toBeLessThanOrEqual(3);
    } else {
      expect(tableBoxes[1]?.y).toBeGreaterThan((tableBoxes[0]?.y ?? 0) + (tableBoxes[0]?.height ?? 0));
      expect(capabilityBoxes[1]?.y).toBeGreaterThan((capabilityBoxes[0]?.y ?? 0) + (capabilityBoxes[0]?.height ?? 0));
    }
  });
}

test("renders nonconformance with exactly 3 body rows and 5 columns", async ({ mount }) => {
  const capabilityValue = (value: number) => ({ state: "available" as const, value, reasonCode: null });
  const capabilityInterval = (lower: number, upper: number) => ({
    lower: capabilityValue(lower),
    upper: capabilityValue(upper),
    intervalMethod: "wald.v1",
    limitingSide: null,
    warnings: [],
  });
  const observedTail = (count: number, proportion: number) => ({
    count: { state: "available" as const, value: count, reasonCode: null },
    proportion: capabilityValue(proportion),
    ppm: capabilityValue(proportion * 1_000_000),
    proportionInterval: {
      lower: capabilityValue(0),
      upper: capabilityValue(0.1),
      intervalMethod: "wilson.v1",
    },
  });
  const expectedTail = (proportion: number) => ({
    proportion: capabilityValue(proportion),
    ppm: capabilityValue(proportion * 1_000_000),
  });

  const component = await mount(
    <DistributionWorkspace
      item={item}
      sourceAvailable
      bootstrap={null}
      runState={null}
      failure={null}
      result={{
        ...previousResult,
        groups: [{
          groupKey: [],
          yResults: [{
            yColumn: { columnId: "sales-id", modelingType: "continuous" },
            yName: "sales_amount",
            quantiles: [],
            blocks: [{
              schemaVersion: "1",
              blockId: "capability",
              kind: "processCapability",
              titleKey: "distribution.report.processCapability",
              status: "available",
              summaryData: null,
              chartData: null,
              capabilityData: {
                specification: { lsl: 1000, target: 2000, usl: 3000, source: "columnProperty" },
                processSummary: {
                  n: 51,
                  mean: 523.7239,
                  movingRangeAverage: 677.1,
                  d2: 1.128379,
                  withinSigma: 600.4645,
                  overallSigma: 731.7753,
                },
                indices: {
                  cp: capabilityValue(0.555),
                  cpk: capabilityValue(-0.264),
                  cpl: capabilityValue(-0.264),
                  cpu: capabilityValue(1.375),
                  cpmWithin: capabilityValue(0.209),
                  pp: capabilityValue(0.456),
                  ppk: capabilityValue(-0.217),
                  ppl: capabilityValue(-0.217),
                  ppu: capabilityValue(1.128),
                  cpmOverall: capabilityValue(0.202),
                },
                intervals: {
                  confidenceLevel: 0.95,
                  cp: capabilityInterval(0.4, 0.7),
                  cpk: capabilityInterval(-0.4, -0.1),
                  cpl: capabilityInterval(-0.4, -0.1),
                  cpu: capabilityInterval(1.0, 1.7),
                  cpmWithin: capabilityInterval(0.1, 0.3),
                  pp: capabilityInterval(0.3, 0.6),
                  ppk: capabilityInterval(-0.3, -0.1),
                  ppl: capabilityInterval(-0.3, -0.1),
                  ppu: capabilityInterval(0.8, 1.4),
                  cpmOverall: capabilityInterval(0.1, 0.3),
                  provenance: {
                    distributionCrate: "statrs",
                    distributionCrateVersion: "0.18.0",
                    parameterization: "standardNormal(0,1)",
                    inverseCdfAlgorithmId: "statrs.inverseCdf.v1",
                    methodVersion: "1.0.0",
                    withinEffectiveDegreesOfFreedom: 30.43832706934947,
                  },
                },
                nonconformance: {
                  observed: {
                    below: observedTail(3, 3 / 51),
                    above: observedTail(0, 0),
                    total: observedTail(3, 3 / 51),
                  },
                  expectedWithin: {
                    below: expectedTail(0.01),
                    above: expectedTail(0.0001),
                    total: expectedTail(0.0101),
                  },
                  expectedOverall: {
                    below: expectedTail(0.02),
                    above: expectedTail(0.001),
                    total: expectedTail(0.021),
                  },
                },
                warnings: [],
              },
            }],
          }],
        }],
      }}
    />,
  );

  const table = component.getByRole("table", { name: "Nonconformance" });
  await expect(table).toBeVisible();
  await expect(table.locator("thead th")).toHaveCount(5);
  await expect(table.locator("tbody tr")).toHaveCount(3);
  await expect(table.getByRole("columnheader", { name: "Region" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Observed Count" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Observed PPM" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Expected Within PPM" })).toBeVisible();
  await expect(table.getByRole("columnheader", { name: "Expected Overall PPM" })).toBeVisible();
  await expect(table.getByText("Proportion")).toHaveCount(0);
  await expect(table.getByText(/Wilson/i)).toHaveCount(0);
  await expect(table.locator("tbody td").first()).toHaveCSS("border-right-style", "solid");
  await expect(table.locator("tbody td").first()).toHaveCSS("border-bottom-style", "solid");
});