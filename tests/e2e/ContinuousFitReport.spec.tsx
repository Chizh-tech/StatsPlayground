import { expect, test } from "@playwright/experimental-ct-react";

import { DistributionWorkspace } from "../../src/components/distribution";
import { ReportBlock } from "../../src/components/distribution/DistributionReport";
import type { DistributionYReportPreferencesV1 } from "../../src/types/distribution";
import "../../src/components/distribution/distribution.css";
import type { DistributionFitDataV1, DistributionReportBlockV1 } from "../../src/types/distribution";

const metric = (value: number | null, reasonCode: string | null = null) => ({
  state: value === null ? "unavailable" as const : "available" as const,
  value,
  reasonCode,
});

const provenance = {
  methodId: "fit.normal.mle.v1",
  methodVersion: "1",
  parameterizationId: "normal.locationScale.v1",
  optimizerId: "closedForm",
  optimizerVersion: "1",
  initializationStrategyId: "closedForm",
  convergenceTolerance: 0,
  iterationLimit: 0,
  dependencyVersions: { statrs: "0.18.0" },
  snapshotId: "snapshot-1",
  configRevision: 2,
  candidateRegistryIds: ["normal" as const],
  compatibilityStatus: "compatibilityPending" as const,
};

const fit: DistributionFitDataV1 = {
  schemaVersion: "1",
  fitId: "fit-normal",
  distributionId: "normal",
  parameterizationId: "normal.locationScale.v1",
  status: "available",
  reasonCode: null,
  parameters: [
    { parameterId: "location", value: metric(3) },
    { parameterId: "scale", value: metric(1.5) },
  ],
  effectiveN: 10,
  logLikelihood: metric(-12),
  aic: metric(28),
  aicc: metric(30),
  bic: metric(29),
  goodnessOfFit: [],
  fittedCurve: { schemaVersion: "1", points: [{ x: 0, y: 0.1 }, { x: 6, y: 0.1 }], provenance },
  diagnostics: [],
  convergence: {
    status: "converged",
    reasonCode: null,
    optimizerId: "closedForm",
    optimizerVersion: "1",
    iterations: 0,
    tolerance: 0,
  },
  provenance,
  warnings: [],
};

const block = (patch: Partial<DistributionReportBlockV1>): DistributionReportBlockV1 => ({
  schemaVersion: "1",
  blockId: "fit-block",
  kind: "continuousFit",
  titleKey: "distribution.report.continuousFit",
  status: "available",
  chartData: null,
  ...patch,
});

test("renders available Continuous Fit parameters and statistics with complete grid lines", async ({ mount }) => {
  const component = await mount(<ReportBlock block={block({ distributionFitData: fit })} />);
  await expect(component.getByRole("heading", { name: "Continuous Fit - Normal" })).toBeVisible();
  await expect(component.getByRole("table", { name: "Normal parameters" })).toBeVisible();
  await expect(component.getByRole("table", { name: "Normal fit statistics" })).toBeVisible();
  await expect(component.getByText("JMP 19 compatibility pending")).toBeVisible();
  await expect(component.getByText(/Convergence: Converged/)).toBeVisible();
  await expect(component.getByText("AICc", { exact: true })).toBeVisible();
  await expect(component.locator(".distribution-fit-table td").first()).toHaveCSS("border-right-style", "solid");
  await expect(component.locator(".distribution-fit-table td").first()).toHaveCSS("border-bottom-style", "solid");
});

test("renders failed fit reason without a fake fit table", async ({ mount }) => {
  const failed: DistributionFitDataV1 = {
    ...fit,
    status: "failed",
    reasonCode: "distribution.fit.optimizerFailed.v1",
    parameters: [],
    fittedCurve: undefined,
    logLikelihood: metric(null, "distribution.fit.optimizerFailed.v1"),
    aic: metric(null, "distribution.fit.optimizerFailed.v1"),
    aicc: metric(null, "distribution.fit.optimizerFailed.v1"),
    bic: metric(null, "distribution.fit.optimizerFailed.v1"),
  };
  const component = await mount(<ReportBlock block={block({ status: "failed", distributionFitData: failed })} />);
  await expect(component.getByText(/Optimization failed/)).toBeVisible();
  await expect(component.locator(".distribution-fit-table")).toHaveCount(0);
  await expect(component.locator("canvas")).toHaveCount(0);
});

test("localizes convergence reasons and preserves unknown reason codes", async ({ mount }) => {
  const convergenceFailure: DistributionFitDataV1 = {
    ...fit,
    convergence: {
      ...fit.convergence,
      status: "failed",
      reasonCode: "distribution.fit.optimizerFailed.v1",
    },
  };
  const known = await mount(<ReportBlock block={block({ distributionFitData: convergenceFailure })} />);
  await expect(known.getByText(/Convergence: Failed \(Optimization failed\)/)).toBeVisible();
  await known.unmount();

  const unknownFailure: DistributionFitDataV1 = {
    ...fit,
    status: "failed",
    reasonCode: "distribution.fit.futureReason.v9",
    fittedCurve: undefined,
  };
  const unknown = await mount(<ReportBlock block={block({ status: "failed", distributionFitData: unknownFailure })} />);
  await expect(unknown.getByText(/distribution\.fit\.futureReason\.v9/)).toBeVisible();
});

test("renders Fit All comparison in backend row order", async ({ mount }) => {
  const component = await mount(<ReportBlock block={block({
    kind: "fitComparison",
    distributionFitComparisonData: {
      schemaVersion: "1",
      comparisonId: "comparison-1",
      candidateRegistryIds: ["normal", "gamma"],
      rows: [
        { distributionId: "normal", status: "available", reasonCode: null, aic: metric(28), aicc: metric(30), bic: metric(29) },
        { distributionId: "gamma", status: "failed", reasonCode: "distribution.fit.domain.v1", aic: metric(null), aicc: metric(null), bic: metric(null) },
      ],
    },
  })} />);
  const table = component.getByRole("table", { name: "Fit Comparison" });
  await expect(table.locator("tbody tr")).toHaveCount(2);
  await expect(table.locator("tbody tr").nth(0).locator("th")).toHaveText("Normal");
  await expect(table.locator("tbody tr").nth(1).locator("th")).toHaveText("Gamma");
  await expect(table.locator("tbody td").first()).toHaveCSS("border-right-style", "solid");
});

test("fit display toggles update preferences without changing fit computation", async ({ mount }) => {
  const preferenceChanges: DistributionYReportPreferencesV1[] = [];
  let computationChanges = 0;
  const component = await mount(<DistributionWorkspace
    item={{
      schemaVersion: "1",
      analysisId: "analysis-1",
      name: "Distribution 1",
      sourceDatasetId: "dataset-1",
      status: "ready",
      loadStatus: "ready",
      configRevision: 2,
      currentConfig: {
        schemaVersion: "1",
        sourceDatasetId: "dataset-1",
        yColumns: [{ columnId: "sales-id", modelingType: "continuous" }],
        weightColumnId: null,
        frequencyColumnId: null,
        byColumnIds: [],
        filterExpr: { kind: "and", exprs: [] },
        confidenceLevel: 0.95,
        histogramsOnly: false,
        enabledCapabilityIds: [],
        capabilityOverrides: [],
        continuousFit: {
          enabledDistributionIds: ["normal"],
          fitAll: false,
          diagnostics: { goodnessOfFit: false, qqPlot: false, cdfPlot: false, ppPlot: false },
        },
      },
    }}
    sourceAvailable
    bootstrap={{
      schemaVersion: "1",
      mode: "continuous",
      canRun: true,
      datasetCount: 1,
      capabilities: ["normal", "gamma"].map((id) => ({
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
    runState={null}
    result={{
      analysisId: "analysis-1",
      configRevision: 2,
      runId: "run-1",
      snapshotId: "snapshot-1",
      completedAt: "2026-08-30T00:00:00Z",
      reportBlocks: [],
      groups: [{
        groupKey: [],
        yResults: [{
          yColumn: { columnId: "sales-id", modelingType: "continuous" },
          yName: "sales_amount",
          quantiles: [],
          blocks: [block({ distributionFitData: fit })],
        }],
      }],
    }}
    onReportPreferencesChange={(_columnId, preferences) => preferenceChanges.push(preferences)}
    onContinuousFitChange={() => { computationChanges += 1; }}
  />);

  const trigger = component.getByRole("button", { name: "Analysis options for sales_amount" });
  await trigger.click();
  await expect(component.getByRole("checkbox", { name: "Fit Normal" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Fit Gamma" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Fit All" })).toBeVisible();
  await expect(component.getByRole("checkbox", { name: "Fit Lognormal" })).toHaveCount(0);
  await expect(component.getByRole("checkbox", { name: "Fit Exponential" })).toHaveCount(0);
  await expect(component.getByRole("checkbox", { name: "Fit Weibull" })).toHaveCount(0);
  const showCurves = component.getByRole("checkbox", { name: "Show Fit Curves" });
  const showDetails = component.getByRole("checkbox", { name: "Show Fit Details" });
  await expect(showCurves).toBeChecked();
  await expect(showDetails).toBeChecked();
  await showCurves.click();
  expect(preferenceChanges).toHaveLength(1);
  expect(preferenceChanges[0].fitOverlays).toBe(false);
  expect(computationChanges).toBe(0);

  await trigger.click();
  await showDetails.click();
  expect(preferenceChanges).toHaveLength(2);
  expect(preferenceChanges[1].fitDetails).toBe(false);
  expect(computationChanges).toBe(0);
});

test("Fit Density follows Overview and Show Fit Curves only changes presentation", async ({ mount }) => {
  let computationChanges = 0;
  const component = await mount(<DistributionWorkspace
    item={{
      schemaVersion: "1",
      analysisId: "analysis-1",
      name: "Distribution 1",
      sourceDatasetId: "dataset-1",
      status: "ready",
      loadStatus: "ready",
      configRevision: 2,
      currentConfig: {
        schemaVersion: "1",
        sourceDatasetId: "dataset-1",
        yColumns: [{ columnId: "sales-id", modelingType: "continuous" }],
        weightColumnId: null,
        frequencyColumnId: null,
        byColumnIds: [],
        filterExpr: { kind: "and", exprs: [] },
        confidenceLevel: 0.95,
        histogramsOnly: false,
        enabledCapabilityIds: [],
        capabilityOverrides: [],
        continuousFit: {
          enabledDistributionIds: ["normal", "gamma"],
          fitAll: false,
          diagnostics: { goodnessOfFit: false, qqPlot: false, cdfPlot: false, ppPlot: false },
        },
      },
    }}
    sourceAvailable
    bootstrap={{
      schemaVersion: "1",
      mode: "continuous",
      canRun: true,
      datasetCount: 1,
      capabilities: ["normal", "gamma"].map((id) => ({
        id: `fit.continuous.${id}`,
        titleKey: `distribution.capability.fit.continuous.${id}`,
        scope: "continuousY",
        menuScope: "distribution",
        statusKey: "distribution.capability.available",
      })),
      observationPolicy: { schemaVersion: "1", dimensions: [] },
      resourceBudget: { maxGroups: 1, maxRowsPerGroup: 10, maxTotalRows: 10, maxTotalBytes: 1024, cancelToken: null },
    }}
    runState={null}
    result={{
      analysisId: "analysis-1",
      configRevision: 2,
      runId: "run-1",
      snapshotId: "snapshot-1",
      completedAt: "2026-08-30T00:00:00Z",
      reportBlocks: [],
      groups: [{
        groupKey: [],
        yResults: [{
          yColumn: { columnId: "sales-id", modelingType: "continuous" },
          yName: "sales_amount",
          quantiles: [],
          blocks: [
            block({
              blockId: "histogram",
              kind: "histogram",
              chartData: {
                schemaVersion: "1",
                kind: "histogramData",
                provenance: { methodId: "synthetic.histogram", snapshotId: "snapshot-1" },
                bins: [
                  { lower: 0, upper: 1, count: 3, probability: 0.3, density: 0.15 },
                  { lower: 1, upper: 2, count: 7, probability: 0.7, density: 0.35 },
                ],
              },
            }),
            block({ distributionFitData: fit }),
            block({
              blockId: "fit-gamma",
              distributionFitData: {
                ...fit,
                fitId: "fit-gamma",
                distributionId: "gamma",
                fittedCurve: {
                  ...fit.fittedCurve!,
                  points: [{ x: 0, y: 0.08 }, { x: 2, y: 0.16 }],
                },
              },
            }),
          ],
        }],
      }],
    }}
    onContinuousFitChange={() => { computationChanges += 1; }}
  />);

  const overview = component.locator('[data-chart-kind="overview"]');
  const fitDensity = component.locator('[data-chart-kind="fit-density"]');
  await expect(overview).toHaveAttribute("data-axis-layout", "horizontal-count");
  await expect(fitDensity).toHaveCount(1);
  await expect(fitDensity).toHaveAttribute("aria-label", "Fit Density");
  const chartKinds = await component.locator("[data-chart-kind]").evaluateAll((elements) =>
    elements.map((element) => element.getAttribute("data-chart-kind")),
  );
  expect(chartKinds.slice(0, 2)).toEqual(["overview", "fit-density"]);

  await component.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await component.getByRole("checkbox", { name: "Show Fit Curves" }).click();
  await expect(fitDensity).toHaveCount(0);
  await expect(overview).toHaveCount(1);
  await expect(overview).toHaveAttribute("data-axis-layout", "horizontal-count");
  expect(computationChanges).toBe(0);
});

test("suppresses Fit Density for failed and empty fitted curves", async ({ mount }) => {
  for (const candidate of [
    { ...fit, status: "failed" as const, reasonCode: "distribution.fit.optimizerFailed.v1", fittedCurve: undefined },
    { ...fit, fittedCurve: { ...fit.fittedCurve!, points: [] } },
  ]) {
    const component = await mount(<DistributionWorkspace
      item={{
        schemaVersion: "1", analysisId: "analysis-1", name: "Distribution 1", sourceDatasetId: "dataset-1",
        status: "ready", loadStatus: "ready", configRevision: 2,
        currentConfig: {
          schemaVersion: "1", sourceDatasetId: "dataset-1", yColumns: [{ columnId: "sales-id", modelingType: "continuous" }],
          weightColumnId: null, frequencyColumnId: null, byColumnIds: [], filterExpr: { kind: "and", exprs: [] },
          confidenceLevel: 0.95, histogramsOnly: false, enabledCapabilityIds: [], capabilityOverrides: [],
        },
      }}
      sourceAvailable bootstrap={null} runState={null}
      result={{
        analysisId: "analysis-1", configRevision: 2, runId: "run-1", snapshotId: "snapshot-1",
        completedAt: "2026-08-30T00:00:00Z", reportBlocks: [], groups: [{ groupKey: [], yResults: [{
          yColumn: { columnId: "sales-id", modelingType: "continuous" }, yName: "sales_amount", quantiles: [], blocks: [
            block({ blockId: "histogram", kind: "histogram", chartData: {
              schemaVersion: "1", kind: "histogramData", provenance: { methodId: "synthetic.histogram", snapshotId: "snapshot-1" },
              bins: [{ lower: 0, upper: 1, count: 3, probability: 1, density: 1 }],
            } }),
            block({ blockId: `fit-${candidate.status}`, distributionFitData: candidate }),
          ],
        }] }],
      }}
    />);
    await expect(component.locator('[data-chart-kind="overview"]')).toHaveCount(1);
    await expect(component.locator('[data-chart-kind="fit-density"]')).toHaveCount(0);
    await component.unmount();
  }
});

test("hides Continuous Fit commands when bootstrap exposes no fit capabilities", async ({ mount }) => {
  const component = await mount(<DistributionWorkspace
    item={{
      schemaVersion: "1",
      analysisId: "analysis-1",
      name: "Distribution 1",
      sourceDatasetId: "dataset-1",
      status: "ready",
      loadStatus: "ready",
      configRevision: 1,
      currentConfig: {
        schemaVersion: "1",
        sourceDatasetId: "dataset-1",
        yColumns: [{ columnId: "sales-id", modelingType: "continuous" }],
        weightColumnId: null,
        frequencyColumnId: null,
        byColumnIds: [],
        filterExpr: { kind: "and", exprs: [] },
        confidenceLevel: 0.95,
        histogramsOnly: false,
        enabledCapabilityIds: [],
        capabilityOverrides: [],
        continuousFit: {
          enabledDistributionIds: [],
          fitAll: false,
          diagnostics: { goodnessOfFit: false, qqPlot: false, cdfPlot: false, ppPlot: false },
        },
      },
    }}
    sourceAvailable
    bootstrap={{
      schemaVersion: "1",
      mode: "continuous",
      canRun: true,
      datasetCount: 1,
      capabilities: [],
      observationPolicy: { schemaVersion: "1", dimensions: [] },
      resourceBudget: { maxGroups: 1, maxRowsPerGroup: 10, maxTotalRows: 10, maxTotalBytes: 1024, cancelToken: null },
    }}
    runState={null}
    result={{
      analysisId: "analysis-1",
      configRevision: 1,
      runId: "run-1",
      snapshotId: "snapshot-1",
      completedAt: "2026-08-30T00:00:00Z",
      reportBlocks: [],
      groups: [{ groupKey: [], yResults: [{ yColumn: { columnId: "sales-id", modelingType: "continuous" }, yName: "sales_amount", quantiles: [], blocks: [] }] }],
    }}
    onContinuousFitChange={() => undefined}
  />);
  await component.getByRole("button", { name: "Analysis options for sales_amount" }).click();
  await expect(component.getByText("Continuous Fit", { exact: true })).toHaveCount(0);
  await expect(component.getByRole("checkbox", { name: "Fit All" })).toHaveCount(0);
});
