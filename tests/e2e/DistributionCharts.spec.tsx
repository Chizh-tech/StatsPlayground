import { expect, test } from "@playwright/experimental-ct-react";

import {
  DistributionChart,
  DistributionOverviewChart,
  ProcessCapabilityChart,
} from "../../src/components/distribution";
import type { DistributionChartDataV1 } from "../../src/types/distribution";

const provenance = {
  methodId: "synthetic.chart",
  methodVersion: "1.0.0",
  compatibilityStatus: "compatibilityPending" as const,
  snapshotId: "snapshot-1",
};
const charts: Array<{ title: string; chart: DistributionChartDataV1; minVisiblePixels?: number }> = [
  {
    title: "Histogram",
    minVisiblePixels: 100,
    chart: {
      schemaVersion: "1",
      kind: "histogramData",
      provenance,
      bins: [
        { lower: 0, upper: 1, count: 3, probability: 0.375, density: 0.375 },
        { lower: 1, upper: 2, count: 5, probability: 0.625, density: 0.625 },
      ],
    },
  },
  {
    title: "Box Plot",
    minVisiblePixels: 100,
    chart: {
      schemaVersion: "1",
      kind: "boxPlotData",
      provenance,
      coordinates: {
        lowerWhisker: 0,
        lowerQuartile: 1,
        median: 2,
        upperQuartile: 3,
        upperWhisker: 4,
        outliers: [7],
      },
    },
  },
  {
    title: "Empirical CDF",
    minVisiblePixels: 100,
    chart: {
      schemaVersion: "1",
      kind: "cdfData",
      provenance,
      points: [{ x: 0, y: 0 }, { x: 0, y: 0.5 }, { x: 2, y: 1 }],
    },
  },
  {
    title: "Normal Quantile",
    minVisiblePixels: 1_500,
    chart: {
      schemaVersion: "1",
      kind: "normalQuantileData",
      provenance,
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
        provenance,
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
    title: "Quantile Box",
    minVisiblePixels: 600,
    chart: {
      schemaVersion: "1",
      kind: "quantileBoxData",
      provenance,
      payload: {
        layers: [
          { probabilityLower: 0.25, probabilityUpper: 0.75, lower: 1.0, upper: 5.0, depth: 1 },
          { probabilityLower: 0.125, probabilityUpper: 0.875, lower: 0.5, upper: 5.5, depth: 2 },
          { probabilityLower: 0.0625, probabilityUpper: 0.9375, lower: 0.25, upper: 5.75, depth: 3 },
        ],
        median: 3.0,
        status: "available",
        reasonCode: null,
        provenance,
      },
    },
  },
];

for (const { title, chart, minVisiblePixels = 100 } of charts) {
  test(`renders nonblank ${title}`, async ({ mount }) => {
    const component = await mount(<DistributionChart chart={chart} title={title} />);
    await expect(component).toHaveAttribute("role", "img");
    const canvas = component.locator("canvas");
    await expect(canvas).toBeVisible();
    const box = await canvas.boundingBox();
    expect(box?.width).toBeGreaterThan(200);
    expect(box?.height).toBeGreaterThan(180);
    await expect.poll(async () => canvas.evaluate((element) => {
      const context = (element as HTMLCanvasElement).getContext("2d");
      if (!context) return 0;
      const pixels = context.getImageData(0, 0, element.width, element.height).data;
      let visible = 0;
      for (let index = 3; index < pixels.length; index += 4) {
        if (pixels[index] > 0) visible += 1;
      }
      return visible;
    })).toBeGreaterThan(minVisiblePixels);
  });
}

test("renders a nonblank combined Overview", async ({ mount }) => {
  const histogram = charts[0].chart;
  const boxPlot = charts[1].chart;
  if (histogram.kind !== "histogramData" || boxPlot.kind !== "boxPlotData") {
    throw new Error("invalid overview fixture");
  }
  const component = await mount(
    <DistributionOverviewChart histogram={histogram} boxPlot={boxPlot} title="Overview" />,
  );
  await expect(component).toHaveAttribute("data-chart-kind", "overview");
  const canvas = component.locator("canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(async () => canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext("2d");
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let visible = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) visible += 1;
    }
    return visible;
  })).toBeGreaterThan(100);
});

test("renders a nonblank combined Overview with density scale", async ({ mount }) => {
  const histogram = charts[0].chart;
  const boxPlot = charts[1].chart;
  if (histogram.kind !== "histogramData" || boxPlot.kind !== "boxPlotData") {
    throw new Error("invalid overview fixture");
  }
  const component = await mount(
    <DistributionOverviewChart
      histogram={histogram}
      boxPlot={boxPlot}
      title="Overview Density"
      valueAxisName="sales_amount"
      densityAxisName="Probability Density"
      fitCurves={[
        { fitId: "fit-normal", distributionId: "normal", points: [{ x: 0, y: 0.1 }, { x: 2, y: 0.5 }] },
        { fitId: "fit-gamma", distributionId: "gamma", points: [{ x: 0, y: 0 }, { x: 2, y: 0.4 }] },
      ]}
    />,
  );
  await expect(component).toHaveAttribute("data-chart-kind", "overview");
  const canvas = component.locator("canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(async () => canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext("2d");
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let visible = 0;
    for (let index = 3; index < pixels.length; index += 4) {
      if (pixels[index] > 0) visible += 1;
    }
    return visible;
  })).toBeGreaterThan(100);
});

test("renders a nonblank Process Capability Histogram", async ({ mount }) => {
  const component = await mount(<ProcessCapabilityChart title="Capability Histogram" chart={{
    bins: [{ lower: 0, upper: 1, count: 3, probability: 1, density: 0.5, belowCount: 1, aboveCount: 0 }],
    specificationLines: { lsl: 0.2, target: 0.5, usl: 0.8, source: "columnProperty" },
    overallDensity: { state: "available", reasonCode: null, coordinates: [{ x: 0, y: 0.1 }, { x: 1, y: 0.2 }] },
    withinDensity: { state: "available", reasonCode: null, coordinates: [{ x: 0, y: 0.12 }, { x: 1, y: 0.18 }] },
    provenance: {
      capabilityMethod: "capability.normal.individuals", normalDensityMethod: "normal.pdf.closedForm.v1",
      snapshotId: "snapshot-1", specFingerprint: "spec:sha256:test",
    },
  }} />);
  await expect(component).toHaveAttribute("data-chart-kind", "process-capability");
  const canvas = component.locator("canvas");
  await expect(canvas).toBeVisible();
  await expect.poll(async () => canvas.evaluate((element) => {
    const context = (element as HTMLCanvasElement).getContext("2d");
    if (!context) return 0;
    const pixels = context.getImageData(0, 0, element.width, element.height).data;
    let visible = 0;
    for (let index = 3; index < pixels.length; index += 4) if (pixels[index] > 0) visible += 1;
    return visible;
  })).toBeGreaterThan(100);
});
