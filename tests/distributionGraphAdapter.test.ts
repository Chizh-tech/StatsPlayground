import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  buildDistributionChartOption,
  buildDistributionFitDensityOption,
  buildDistributionOverviewOption,
  buildProcessCapabilityChartOption,
  formatDistributionAxisLabel,
  toGraphBuilderInput,
} from "../src/graphCore/distributionAdapter.ts";

assert.equal(formatDistributionAxisLabel(8586.5890174457), "8,586.59");
assert.equal(formatDistributionAxisLabel(0.0025), "0.0025");
assert.equal(formatDistributionAxisLabel(27_923_379_591), "27.9B");

const histogram = {
  kind: "histogramData" as const,
  schemaVersion: "1" as const,
  provenance: { methodId: "synthetic.histogram", snapshotId: "snapshot-1" },
  bins: [{ lower: 0.125, upper: 0.375, count: 7.5, probability: 1, density: 4 }],
};
const qq = {
  kind: "qqData" as const,
  schemaVersion: "1" as const,
  provenance: { methodId: "synthetic.qq", snapshotId: "snapshot-1" },
  points: [{ x: -1.25, y: -1.125 }, { x: 1.25, y: 1.375 }],
};
assert.deepEqual(toGraphBuilderInput(histogram).payload, histogram);
assert.deepEqual(toGraphBuilderInput(qq).payload, qq);
assert.equal(toGraphBuilderInput(histogram).display.role, "distribution");

const histogramOption = buildDistributionChartOption(histogram, "Histogram") as {
  series: Array<{ data: unknown[] }>;
};
assert.deepEqual(histogramOption.series[0].data, [[0.125, 0.375, 7.5]]);

const box = {
  kind: "boxPlotData" as const,
  schemaVersion: "1" as const,
  provenance: { methodId: "synthetic.box", snapshotId: "snapshot-1" },
  coordinates: {
    lowerWhisker: 1,
    lowerQuartile: 2,
    median: 3,
    upperQuartile: 4,
    upperWhisker: 5,
    outliers: [9],
  },
};
const boxOption = buildDistributionChartOption(box, "Box Plot") as {
  series: Array<{ data: unknown[] }>;
};
assert.deepEqual(boxOption.series[0].data, [[1, 2, 3, 4, 5]]);
assert.deepEqual(boxOption.series[1].data, [[0, 9]]);

const normalQuantile = {
  kind: "normalQuantileData" as const,
  schemaVersion: "1" as const,
  provenance: {
    methodId: "normalScore.documented.rankOverNPlus1",
    methodVersion: "1.0.0",
    compatibilityStatus: "documentedCompatible" as const,
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
    status: "available" as const,
    reasonCode: null,
    provenance: {
      methodId: "normalScore.documented.rankOverNPlus1",
      methodVersion: "1.0.0",
      compatibilityStatus: "documentedCompatible" as const,
      snapshotId: "snapshot-1",
    },
    referenceLineProvenance: {
      methodId: "normalQuantile.referenceLine.public.v1",
      methodVersion: "1.0.0",
      compatibilityStatus: "compatibilityPending" as const,
      snapshotId: "snapshot-1",
    },
    confidenceBandProvenance: {
      methodId: "normalQuantile.pointwiseBand.public.v1",
      methodVersion: "1.0.0",
      compatibilityStatus: "compatibilityPending" as const,
      snapshotId: "snapshot-1",
    },
  },
};
const normalQuantileOption = buildDistributionChartOption(normalQuantile, "Normal Quantile") as {
  series: Array<{ type: string; data: unknown[] }>;
};
assert.equal(normalQuantileOption.series.length, 3);
assert.equal(normalQuantileOption.series[0].type, "line");
assert.equal(normalQuantileOption.series[1].type, "custom");
assert.equal(normalQuantileOption.series[2].type, "scatter");
assert.deepEqual(normalQuantileOption.series[2].data, [
  [-0.6744897501960817, -2],
  [0, 0],
  [0.6744897501960817, 3],
]);

const quantileBox = {
  kind: "quantileBoxData" as const,
  schemaVersion: "1" as const,
  provenance: {
    methodId: "quantileBox.public.letterValue.type6.v1",
    methodVersion: "1.0.0",
    compatibilityStatus: "intentionalDifference" as const,
    snapshotId: "snapshot-1",
  },
  payload: {
    layers: [
      {
        probabilityLower: 0.25,
        probabilityUpper: 0.75,
        lower: 1,
        upper: 5,
        depth: 1,
      },
      {
        probabilityLower: 0.125,
        probabilityUpper: 0.875,
        lower: 0.5,
        upper: 5.5,
        depth: 2,
      },
    ],
    median: 3,
    status: "available" as const,
    reasonCode: null,
    provenance: {
      methodId: "quantileBox.public.letterValue.type6.v1",
      methodVersion: "1.0.0",
      compatibilityStatus: "intentionalDifference" as const,
      snapshotId: "snapshot-1",
    },
  },
};
const quantileBoxOption = buildDistributionChartOption(quantileBox, "Quantile Box") as {
  xAxis: { min?: number; max?: number };
  series: Array<{ type: string; data: unknown[] }>;
};
assert.equal(quantileBoxOption.xAxis.max, 1);
assert.equal(quantileBoxOption.series[0].type, "custom");
assert.deepEqual(quantileBoxOption.series[0].data, [
  [0.25, 0.75, 1, 5, 1],
  [0.125, 0.875, 0.5, 5.5, 2],
]);
assert.equal(quantileBoxOption.series[1].type, "line");

const overviewOption = buildDistributionOverviewOption(histogram, box, "Overview") as {
  xAxis: Array<{ type: string; min?: number; max?: number; name?: string }>;
  yAxis: Array<{ type: string; min?: number; max?: number; name?: string }>;
  series: Array<{ data: unknown[] }>;
};
assert.equal(overviewOption.xAxis[0].type, "value");
assert.equal(overviewOption.xAxis[0].min, 0);
assert.equal(overviewOption.xAxis[0].max, 7.5);
assert.equal(overviewOption.xAxis[0].name, "Count");
assert.equal(overviewOption.xAxis[1].type, "category");
assert.equal(overviewOption.yAxis[0].type, "value");
assert.equal(overviewOption.yAxis[0].min, 0.125);
assert.equal(overviewOption.yAxis[0].max, 9);
assert.equal(overviewOption.yAxis[0].name, "Value");
assert.equal(overviewOption.yAxis[1].min, overviewOption.yAxis[0].min);
assert.equal(overviewOption.yAxis[1].max, overviewOption.yAxis[0].max);
assert.deepEqual(overviewOption.series[0].data, [[7.5, 0.125, 0.375]]);
assert.deepEqual(overviewOption.series[1].data, [[1, 2, 3, 4, 5]]);

const histogramOnlyOverview = buildDistributionOverviewOption(
  histogram,
  null,
  "Overview",
  { lsl: 0, target: 0.25, usl: 0.5, source: "columnProperty" },
  "sales_amount",
) as {
  xAxis: Array<{ min?: number; max?: number; name?: string }>;
  yAxis: Array<{ min?: number; max?: number; name?: string }>;
  series: Array<{
    data: unknown[];
    markLine?: { label?: { show?: boolean }; data?: Array<{ yAxis?: number }> };
  }>;
};
assert.equal(histogramOnlyOverview.xAxis[0].min, 0);
assert.equal(histogramOnlyOverview.xAxis[0].max, 7.5);
assert.equal(histogramOnlyOverview.xAxis[0].name, "Count");
assert.equal(histogramOnlyOverview.yAxis[0].min, 0);
assert.equal(histogramOnlyOverview.yAxis[0].max, 0.5);
assert.equal(histogramOnlyOverview.yAxis[0].name, "sales_amount");
assert.deepEqual(histogramOnlyOverview.series[0].data, [[7.5, 0.125, 0.375]]);
assert.deepEqual(
  histogramOnlyOverview.series.find((series) => series.markLine)?.markLine?.data?.map((line) => line.yAxis),
  [0, 0.25, 0.5],
);
assert.equal(histogramOnlyOverview.series.find((series) => series.markLine)?.markLine?.label?.show, true);

const namedOverview = buildDistributionOverviewOption(
  histogram,
  box,
  "Overview",
  undefined,
  "sales_amount",
) as {
  xAxis: Array<{ max?: number; name?: string }>;
  yAxis: Array<{ max?: number; name?: string }>;
  series: Array<{ data: unknown[] }>;
};
assert.equal(namedOverview.xAxis[0].name, "Count");
assert.equal(namedOverview.yAxis[0].name, "sales_amount");
assert.deepEqual(namedOverview.series[0].data, [[7.5, 0.125, 0.375]]);

const fitDensityOption = buildDistributionFitDensityOption(
  {
    ...histogram,
    bins: [
      { lower: 0, upper: 1, count: 3, probability: 0.3, density: 0.15 },
      { lower: 1, upper: 2, count: 7, probability: 0.7, density: 0.35 },
    ],
  },
  [
    {
      distributionId: "gamma",
      points: [{ x: 0.25, y: 0.11 }, { x: 1.75, y: 0.22 }],
    },
    {
      distributionId: "normal",
      points: [{ x: -0.5, y: 0.05 }, { x: 2.5, y: 0.18 }],
    },
  ],
  "Fit Density",
  "sales_amount",
  "Probability Density",
) as {
  legend: { data: string[] };
  xAxis: { min?: number; max?: number; name?: string };
  yAxis: { min?: number; max?: number; name?: string };
  series: Array<{
    name: string;
    type: string;
    data: number[][];
    lineStyle?: { color?: string };
  }>;
};
assert.deepEqual(fitDensityOption.legend.data, ["normal", "gamma"]);
assert.equal(fitDensityOption.xAxis.min, -0.5);
assert.equal(fitDensityOption.xAxis.max, 2.5);
assert.equal(fitDensityOption.xAxis.name, "sales_amount");
assert.equal(fitDensityOption.yAxis.min, 0);
assert.equal(fitDensityOption.yAxis.max, 0.35);
assert.equal(fitDensityOption.yAxis.name, "Probability Density");
assert.deepEqual(fitDensityOption.series[0].data, [[0, 1, 0.15], [1, 2, 0.35]]);
assert.equal(fitDensityOption.series[1].name, "normal");
assert.deepEqual(fitDensityOption.series[1].data, [[-0.5, 0.05], [2.5, 0.18]]);
assert.equal(fitDensityOption.series[2].name, "gamma");
assert.deepEqual(fitDensityOption.series[2].data, [[0.25, 0.11], [1.75, 0.22]]);
assert.notEqual(fitDensityOption.series[1].lineStyle?.color, fitDensityOption.series[2].lineStyle?.color);
assert.ok(Number.isFinite(fitDensityOption.xAxis.min));
assert.ok(Number.isFinite(fitDensityOption.xAxis.max));
assert.ok(Number.isFinite(fitDensityOption.yAxis.max));

const normalOnlyFitDensity = buildDistributionFitDensityOption(
  histogram,
  [{ distributionId: "normal", points: [{ x: 0, y: 0.18 }, { x: 2, y: 0.15 }] }],
  "Fit Density",
) as { series: Array<{ name: string; type: string; data: number[][]; lineStyle?: { color?: string } }> };
const reorderedFitDensity = buildDistributionFitDensityOption(
  histogram,
  [
    { distributionId: "normal", points: [{ x: 0, y: 0.18 }, { x: 2, y: 0.15 }] },
    { distributionId: "gamma", points: [{ x: 0, y: 0.12 }, { x: 2, y: 0.2 }] },
  ],
  "Fit Density",
) as { series: Array<{ name: string; type: string; data: number[][]; lineStyle?: { color?: string } }> };
assert.equal(
  normalOnlyFitDensity.series.find((series) => series.name === "normal")?.lineStyle?.color,
  reorderedFitDensity.series.find((series) => series.name === "normal")?.lineStyle?.color,
);
assert.equal(fitDensityOption.series[0].type, "custom");
assert.equal(fitDensityOption.series[1].type, "line");
assert.deepEqual(fitDensityOption.series[1].data, [[-0.5, 0.05], [2.5, 0.18]]);

const zeroCountOverview = buildDistributionOverviewOption({
  ...histogram,
  bins: [{ lower: 0, upper: 1, count: 0, probability: 0, density: 0 }],
}, null, "Overview") as {
  series: Array<{
    data: number[][];
    renderItem?: (
      params: { dataIndex: number },
      api: { value: (index: number) => number; coord: (value: [number, number]) => [number, number] },
    ) => { shape: { width: number } };
  }>;
};
assert.deepEqual(zeroCountOverview.series[0].data, [[0, 0, 1]]);
const zeroTuple = zeroCountOverview.series[0].data[0];
const zeroShape = zeroCountOverview.series[0].renderItem?.(
  { dataIndex: 0 },
  { value: (index) => zeroTuple[index], coord: ([x, y]) => [x * 10, y * 10] },
);
assert.equal(zeroShape?.shape.width, 0);

const pollutedOverviewOption = buildDistributionOverviewOption({
  kind: "histogramData",
  schemaVersion: "1",
  provenance: {
    methodId: "synthetic.histogram",
    methodVersion: "1.0.0",
    compatibilityStatus: "compatibilityPending",
    snapshotId: "snapshot-1",
  },
  bins: [
    { lower: 120.0, upper: 220.0, count: 17_445_714, probability: 0.8965711773901062, density: 0.008965711773901062 },
    { lower: 220.0, upper: 360.0, count: 2_012_345, probability: 0.10342882260989389, density: 0.0007387773043563848 },
  ],
}, {
  kind: "boxPlotData",
  schemaVersion: "1",
  provenance: {
    methodId: "synthetic.box",
    methodVersion: "1.0.0",
    compatibilityStatus: "compatibilityPending",
    snapshotId: "snapshot-1",
  },
  coordinates: {
    lowerWhisker: 80,
    lowerQuartile: 140,
    median: 3000,
    upperQuartile: 6000,
    upperWhisker: 8554.68,
    outliers: [8554.68],
  },
}, "Overview", {
  lsl: 0,
  target: 3000,
  usl: 6000,
  source: "analysisOverride",
}) as {
  grid: Array<{ right?: number }>;
  xAxis: Array<{ min?: number; max?: number; axisLabel?: { show?: boolean } }>;
  yAxis: Array<{ min?: number; max?: number; axisLabel?: { show?: boolean } }>;
  series: Array<{
    type: string;
    data?: unknown[];
    xAxisIndex?: number;
    yAxisIndex?: number;
    markLine?: { label?: { show?: boolean }; data?: Array<{ yAxis: number }> };
  }>;
};

assert.equal(pollutedOverviewOption.xAxis[0].min, 0);
assert.equal(pollutedOverviewOption.xAxis[0].max, 17_445_714);
assert.ok((pollutedOverviewOption.yAxis[0].max ?? 0) >= 8554.68);
assert.equal(pollutedOverviewOption.yAxis[1].min, pollutedOverviewOption.yAxis[0].min);
assert.equal(pollutedOverviewOption.yAxis[1].max, pollutedOverviewOption.yAxis[0].max);
assert.deepEqual(pollutedOverviewOption.series[0].data, [
  [17_445_714, 120, 220],
  [2_012_345, 220, 360],
]);
assert.ok((pollutedOverviewOption.grid[0].right ?? 0) >= 32);

const specCarrierSeries = pollutedOverviewOption.series.filter((series) =>
  series.type === "line" && series.markLine && Array.isArray(series.markLine.data)
);
assert.equal(specCarrierSeries.length, 2);
assert.deepEqual(specCarrierSeries[0].markLine?.data?.map((line) => line.yAxis), [0, 3000, 6000]);
assert.equal(specCarrierSeries[0].markLine?.label?.show, true);
assert.deepEqual(specCarrierSeries[1].markLine?.data?.map((line) => line.yAxis), [0, 3000, 6000]);
assert.equal(specCarrierSeries[1].markLine?.label?.show, false);
assert.deepEqual(
  pollutedOverviewOption.series.slice(1, 3).map((series) => [series.type, series.xAxisIndex, series.yAxisIndex]),
  [["boxplot", 1, 1], ["scatter", 1, 1]],
);

const overviewHistogramSeries = pollutedOverviewOption.series[0] as typeof pollutedOverviewOption.series[number] & {
  renderItem: (
    params: { dataIndex: number },
    api: { value: (index: number) => number; coord: (value: [number, number]) => [number, number] },
  ) => { type: string; shape: { width: number; height: number } };
};
const overviewHistogramTuple = overviewHistogramSeries.data?.[0] as number[];
const overviewHistogramShape = overviewHistogramSeries.renderItem(
  { dataIndex: 0 },
  { value: (index) => overviewHistogramTuple[index], coord: ([x, y]) => [x / 100_000, y] },
);
assert.equal(overviewHistogramShape.type, "rect");
assert.ok(overviewHistogramShape.shape.width > 0);
assert.ok(overviewHistogramShape.shape.height > 0);

const noSpecOverview = buildDistributionOverviewOption(
  {
    kind: "histogramData",
    schemaVersion: "1",
    provenance: {
      methodId: "synthetic.histogram",
      methodVersion: "1.0.0",
      compatibilityStatus: "compatibilityPending",
      snapshotId: "snapshot-1",
    },
    bins: [{ lower: 0, upper: 1, count: 3, probability: 0.6, density: 0.6 }],
  },
  {
    kind: "boxPlotData",
    schemaVersion: "1",
    provenance: {
      methodId: "synthetic.box",
      methodVersion: "1.0.0",
      compatibilityStatus: "compatibilityPending",
      snapshotId: "snapshot-1",
    },
    coordinates: {
      lowerWhisker: 0,
      lowerQuartile: 0.25,
      median: 0.5,
      upperQuartile: 0.75,
      upperWhisker: 1,
      outliers: [],
    },
  },
  "Overview",
  undefined,
  "count",
) as {
  series: Array<{ type: string; markLine?: { data?: Array<{ yAxis: number }> } }>;
};
const noSpecCarriers = noSpecOverview.series.filter((series) =>
  series.type === "line" && series.markLine && Array.isArray(series.markLine.data)
);
assert.equal(noSpecCarriers.length, 0);

const capabilityOption = buildProcessCapabilityChartOption({
  bins: [{ lower: 0, upper: 1, count: 3, probability: 0.3, density: 0.15, belowCount: 1, aboveCount: 0 }],
  specificationLines: { lsl: 0.2, target: 0.5, usl: 0.8, source: "columnProperty" },
  overallDensity: {
    state: "available", reasonCode: null, coordinates: [{ x: 0, y: 0.1 }, { x: 1, y: 0.2 }],
  },
  withinDensity: {
    state: "available", reasonCode: null, coordinates: [{ x: 0, y: 0.12 }, { x: 1, y: 0.18 }],
  },
  provenance: {
    capabilityMethod: "capability.normal.individuals", normalDensityMethod: "normal.pdf.closedForm.v1",
    snapshotId: "snapshot-1", specFingerprint: "spec:sha256:test",
  },
}, "Capability Histogram", "sales_amount", "Probability Density") as {
  xAxis: { min?: number; max?: number; name?: string };
  yAxis: { min?: number; max?: number; name?: string };
  series: Array<{ data: unknown[]; markLine?: { data: Array<{ xAxis: number }> } }>;
};
assert.equal(capabilityOption.xAxis.min, 0);
assert.equal(capabilityOption.xAxis.max, 1);
assert.equal(capabilityOption.xAxis.name, "sales_amount");
assert.equal(capabilityOption.yAxis.min, 0);
assert.equal(capabilityOption.yAxis.max, 0.2);
assert.equal(capabilityOption.yAxis.name, "Probability Density");
assert.deepEqual(capabilityOption.series[0].data, [[0, 0.15]]);
assert.deepEqual(capabilityOption.series[1].data, [[0, 0.1], [1, 0.2]]);
assert.deepEqual(capabilityOption.series[2].data, [[0, 0.12], [1, 0.18]]);
assert.deepEqual(
  capabilityOption.series[1].markLine?.data.map((line) => line.xAxis),
  [0.2, 0.5, 0.8],
);
const capabilityLineStyles = capabilityOption.series[1].markLine?.data.map((line) => line.lineStyle) ?? [];
assert.equal(capabilityLineStyles.length, 3);
assert.equal(capabilityLineStyles[1]?.type, "dashed");
assert.equal(capabilityLineStyles[0]?.type ?? "solid", "solid");
assert.equal(capabilityLineStyles[2]?.type, "dotted");
assert.notDeepEqual(capabilityLineStyles[0], capabilityLineStyles[1]);
assert.notDeepEqual(capabilityLineStyles[1], capabilityLineStyles[2]);
assert.notDeepEqual(capabilityLineStyles[0], capabilityLineStyles[2]);

const cdf = {
  kind: "cdfData" as const,
  schemaVersion: "1" as const,
  provenance: { methodId: "synthetic.ecdf", snapshotId: "snapshot-1" },
  points: [{ x: 1, y: 0 }, { x: 1, y: 0.5 }, { x: 2, y: 1 }],
};
const cdfOption = buildDistributionChartOption(cdf, "ECDF") as {
  series: Array<{ data: unknown[] }>;
};
assert.deepEqual(cdfOption.series[0].data, [[1, 0], [1, 0.5], [2, 1]]);

const source = readFileSync(
  new URL("../src/graphCore/distributionAdapter.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(source, /from ["']\.\/transform|histogramBins\(|quantile\(|computeBox|fitDistribution/i);
assert.doesNotMatch(source, /inverse_cdf|inverseCdf|normalCdf|erf\(/i);
console.log("distribution graph adapter OK");