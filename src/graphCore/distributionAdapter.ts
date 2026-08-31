import type {
  DistributionChartDataV1,
  ProcessCapabilityChartDataV1,
} from "@/types/distribution";
import type {
  ContinuousDistributionIdV1,
  DistributionCoordinateV1,
} from "@/types/distribution";
import { getGraphTheme } from "./theme";

export function formatDistributionAxisLabel(value: number): string {
  if (!Number.isFinite(value)) return "";
  const absolute = Math.abs(value);
  if (absolute >= 1_000_000_000) {
    return `${Number((value / 1_000_000_000).toFixed(1))}B`;
  }
  if (absolute >= 1_000_000) {
    return `${Number((value / 1_000_000).toFixed(1))}M`;
  }
  if (absolute > 0 && absolute < 0.000001) {
    return value.toExponential(2);
  }
  return new Intl.NumberFormat("en-US", {
    maximumFractionDigits: absolute >= 1 ? 2 : 6,
  }).format(value);
}

export interface DistributionGraphInputV1 {
  schemaVersion: "1";
  source: "distribution";
  chartKind: DistributionChartDataV1["kind"];
  payload: DistributionChartDataV1;
  display: {
    role: "distribution";
    interactive: true;
    exportable: true;
  };
}

export interface DistributionFitCurveInputV1 {
  fitId: string;
  distributionId: ContinuousDistributionIdV1;
  points: DistributionCoordinateV1[];
}

export function toGraphBuilderInput(
  block: DistributionChartDataV1,
): DistributionGraphInputV1 {
  return {
    schemaVersion: "1",
    source: "distribution",
    chartKind: block.kind,
    payload: structuredClone(block),
    display: {
      role: "distribution",
      interactive: true,
      exportable: true,
    },
  };
}

export function buildDistributionChartOption(
  chart: DistributionChartDataV1,
  title: string,
): Record<string, unknown> {
  const theme = getGraphTheme();
  const base = {
    animation: false,
    backgroundColor: "transparent",
    title: { text: title, left: 8, top: 4, textStyle: { color: theme.fgPrimary, fontSize: 12 } },
    grid: { left: 52, right: 18, top: 36, bottom: 36, containLabel: false },
    tooltip: { trigger: "axis" },
  };

  if (chart.kind === "histogramData") {
    return {
      ...base,
      xAxis: axis(theme, "value"),
      yAxis: axis(theme, "value"),
      series: [{
        type: "custom",
        clip: true,
        data: chart.bins.map((bin) => [bin.lower, bin.upper, bin.count]),
        renderItem: (_params: unknown, api: {
          value: (index: number) => number;
          coord: (value: [number, number]) => [number, number];
        }) => {
          const lower = api.value(0);
          const upper = api.value(1);
          const count = api.value(2);
          const upperLeft = api.coord([lower, count]);
          const lowerRight = api.coord([upper, 0]);
          return {
            type: "rect",
            shape: {
              x: upperLeft[0] + 0.5,
              y: upperLeft[1],
              width: Math.max(1, lowerRight[0] - upperLeft[0] - 1),
              height: lowerRight[1] - upperLeft[1],
            },
            style: { fill: theme.accent, opacity: 0.68, stroke: theme.accent, lineWidth: 1 },
          };
        },
      }],
    };
  }

  if (chart.kind === "boxPlotData") {
    const values = chart.coordinates;
    return {
      ...base,
      xAxis: axis(theme, "category", [""]),
      yAxis: axis(theme, "value"),
      series: [
        {
          type: "boxplot",
          clip: true,
          data: [[
            values.lowerWhisker,
            values.lowerQuartile,
            values.median,
            values.upperQuartile,
            values.upperWhisker,
          ]],
          itemStyle: { color: theme.bgCanvas, borderColor: theme.accent, borderWidth: 1.5 },
        },
        {
          type: "scatter",
          clip: true,
          data: values.outliers.map((value) => [0, value]),
          symbolSize: 6,
          itemStyle: { color: theme.accent },
        },
      ],
    };
  }

  if (chart.kind === "normalQuantileData") {
    const payload = chart.payload;
    const hasBand = payload.confidenceBand.length > 0;
    return {
      ...base,
      xAxis: axis(theme, "value"),
      yAxis: axis(theme, "value"),
      series: [
        {
          name: "Reference line",
          type: "line",
          clip: true,
          showSymbol: false,
          data: payload.referenceLine.map((point) => [point.x, point.y]),
          lineStyle: { color: theme.fgPrimary, width: 1.5 },
        },
        {
          name: "Pointwise band",
          type: "custom",
          clip: true,
          data: payload.confidenceBand.map((point) => [point.x, point.lower, point.upper]),
          renderItem: (_params: unknown, api: {
            value: (index: number) => number;
            coord: (value: [number, number]) => [number, number];
          }) => {
            const x = api.value(0);
            const lower = api.value(1);
            const upper = api.value(2);
            const upperCoord = api.coord([x, upper]);
            const lowerCoord = api.coord([x, lower]);
            return {
              type: "line",
              shape: {
                x1: upperCoord[0],
                y1: upperCoord[1],
                x2: lowerCoord[0],
                y2: lowerCoord[1],
              },
              style: {
                stroke: theme.categorical[0],
                opacity: hasBand ? 0.35 : 0,
                lineWidth: 1,
              },
            };
          },
        },
        {
          name: "Observed points",
          type: "scatter",
          clip: true,
          data: payload.points.map((point) => [point.normalScore, point.observedValue]),
          symbolSize: 6,
          itemStyle: { color: theme.accent },
        },
      ],
    };
  }

  if (chart.kind === "quantileBoxData") {
    const payload = chart.payload;
    return {
      ...base,
      xAxis: axis(theme, "value", undefined, [0, 1]),
      yAxis: axis(theme, "value"),
      series: [
        {
          name: "Quantile layers",
          type: "custom",
          clip: true,
          data: payload.layers.map((layer) => [
            layer.probabilityLower,
            layer.probabilityUpper,
            layer.lower,
            layer.upper,
            layer.depth,
          ]),
          renderItem: (_params: unknown, api: {
            value: (index: number) => number;
            coord: (value: [number, number]) => [number, number];
          }) => {
            const probabilityLower = api.value(0);
            const probabilityUpper = api.value(1);
            const lower = api.value(2);
            const upper = api.value(3);
            const depth = api.value(4);
            const leftTop = api.coord([probabilityLower, upper]);
            const rightBottom = api.coord([probabilityUpper, lower]);
            return {
              type: "rect",
              shape: {
                x: leftTop[0],
                y: leftTop[1],
                width: Math.max(1, rightBottom[0] - leftTop[0]),
                height: Math.max(1, rightBottom[1] - leftTop[1]),
              },
              style: {
                fill: theme.accent,
                opacity: Math.max(0.15, 0.45 - Math.min(depth, 6) * 0.05),
                stroke: theme.accent,
                lineWidth: 1,
              },
            };
          },
        },
        {
          name: "Median",
          type: "line",
          clip: true,
          showSymbol: false,
          data: [
            [0.48, payload.median],
            [0.52, payload.median],
          ],
          lineStyle: { color: theme.fgPrimary, width: 1.5 },
        },
      ],
    };
  }

  if ("points" in chart) {
    return {
      ...base,
      xAxis: axis(theme, "value"),
      yAxis: axis(theme, "value", undefined, chart.kind === "cdfData" ? [0, 1] : undefined),
      series: [{
        type: "line",
        clip: true,
        showSymbol: chart.kind !== "cdfData",
        step: chart.kind === "cdfData" ? "end" : false,
        data: chart.points.map((point) => [point.x, point.y]),
        lineStyle: { color: theme.accent, width: 2 },
        itemStyle: { color: theme.accent },
      }],
    };
  }

  return { ...base, series: [] };
}

export function buildDistributionOverviewOption(
  histogram: Extract<DistributionChartDataV1, { kind: "histogramData" }>,
  boxPlot: Extract<DistributionChartDataV1, { kind: "boxPlotData" }> | null,
  title: string,
  specificationLines?: { lsl: number | null; target: number | null; usl: number | null; source: string },
  valueAxisName = "Value",
  densityAxisName = "Probability Density",
  fitCurves: DistributionFitCurveInputV1[] = [],
): Record<string, unknown> {
  const theme = getGraphTheme();
  const coordinates = boxPlot?.coordinates;
  const orderedFitCurves = [...fitCurves].sort((left, right) =>
    left.distributionId.localeCompare(right.distributionId));
  const finiteFitPoints = orderedFitCurves.flatMap((curve) =>
    curve.points.filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y)));
  const specValues = [specificationLines?.lsl, specificationLines?.target, specificationLines?.usl]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const valueExtent = [
    ...histogram.bins.flatMap((bin) => [bin.lower, bin.upper]),
    ...(coordinates ? [coordinates.lowerWhisker, coordinates.upperWhisker, ...coordinates.outliers] : []),
    ...specValues,
    ...finiteFitPoints.map((point) => point.x),
  ];
  const valueMin = Math.min(...valueExtent);
  const valueMax = Math.max(...valueExtent);
  const densityMax = Math.max(
    0,
    ...histogram.bins.map((bin) => bin.density),
    ...finiteFitPoints.map((point) => point.y),
  );
  const fitLabels: Record<ContinuousDistributionIdV1, string> = {
    normal: "Normal",
    lognormal: "Lognormal",
    exponential: "Exponential",
    gamma: "Gamma",
    weibull: "Weibull",
  };
  const fitColors: Record<ContinuousDistributionIdV1, string> = {
    normal: theme.categorical[0] ?? theme.accent,
    lognormal: theme.categorical[1] ?? theme.accent,
    exponential: theme.categorical[2] ?? theme.accent,
    gamma: theme.categorical[3] ?? theme.accent,
    weibull: theme.categorical[4] ?? theme.accent,
  };

  const specMarkLineData: Array<[string, number | null | undefined]> = [
    ["LSL", specificationLines?.lsl],
    ["Target", specificationLines?.target],
    ["USL", specificationLines?.usl],
  ];
  const verticalSpecMarkLineData = buildSpecificationMarkLineData(specMarkLineData, "xAxis", theme);
  const barStyles = histogram.bins.map(() => ({
    fill: theme.accent,
    opacity: 0.68,
    stroke: theme.accent,
    lineWidth: 1,
  }));
  const specCarrierSeries = verticalSpecMarkLineData.length > 0
    ? [
        {
          type: "line",
          clip: true,
          xAxisIndex: 0,
          yAxisIndex: 0,
          data: [],
          markLine: {
            silent: true,
            symbol: "none",
            label: { color: theme.fgSecondary, formatter: "{b}", position: "insideEndTop" },
            data: verticalSpecMarkLineData,
          },
        },
        ...(boxPlot ? [{
          type: "line",
          clip: true,
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: [],
          markLine: {
            silent: true,
            symbol: "none",
            label: { show: false },
            data: verticalSpecMarkLineData,
          },
        }] : []),
      ]
    : [];
  const boxSeries = coordinates
    ? [
        {
          type: "boxplot",
          clip: true,
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: [[
            coordinates.lowerWhisker,
            coordinates.lowerQuartile,
            coordinates.median,
            coordinates.upperQuartile,
            coordinates.upperWhisker,
          ]],
          itemStyle: { color: theme.bgCanvas, borderColor: theme.accent, borderWidth: 1.5 },
        },
        {
          type: "scatter",
          clip: true,
          xAxisIndex: 1,
          yAxisIndex: 1,
          data: coordinates.outliers.map((value) => [value, 0]),
          symbolSize: 6,
          itemStyle: { color: theme.accent },
        },
      ]
    : [];
  const fitSeries = orderedFitCurves.map((curve) => ({
    name: fitLabels[curve.distributionId],
    type: "line",
    clip: true,
    showSymbol: false,
    xAxisIndex: 0,
    yAxisIndex: 0,
    data: curve.points.map((point) => [point.x, point.y]),
    lineStyle: { color: fitColors[curve.distributionId], width: 2 },
    itemStyle: { color: fitColors[curve.distributionId] },
  }));

  return {
    animation: false,
    backgroundColor: "transparent",
    title: { text: title, left: 8, top: 4, textStyle: { color: theme.fgPrimary, fontSize: 12 } },
    legend: {
      show: orderedFitCurves.length > 0,
      data: orderedFitCurves.map((curve) => fitLabels[curve.distributionId]),
      right: 40,
      top: 6,
      textStyle: { color: theme.fgSecondary, fontSize: 10 },
    },
    tooltip: { trigger: "axis" },
    grid: boxPlot
      ? [
          { left: 72, right: 40, top: 42, bottom: 94 },
          { left: 72, right: 40, height: 34, bottom: 38 },
        ]
      : [{ left: 72, right: 40, top: 42, bottom: 54 }],
    xAxis: [
      {
        ...axis(theme, "value", undefined, [valueMin, valueMax]),
        gridIndex: 0,
        name: boxPlot ? undefined : valueAxisName,
        nameLocation: "middle",
        nameGap: 30,
        axisLabel: boxPlot ? { show: false } : axis(theme, "value").axisLabel,
      },
      ...(boxPlot ? [{
        ...axis(theme, "value", undefined, [valueMin, valueMax]),
        gridIndex: 1,
        name: valueAxisName,
        nameLocation: "middle",
        nameGap: 30,
      }] : []),
    ],
    yAxis: [
      {
        ...axis(theme, "value", undefined, [0, densityMax]),
        gridIndex: 0,
        name: densityAxisName,
        nameLocation: "middle",
        nameGap: 48,
      },
      ...(boxPlot ? [{ ...axis(theme, "category", [""]), gridIndex: 1, axisLabel: { show: false } }] : []),
    ],
    series: [
      {
        type: "custom",
        clip: true,
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: histogram.bins.map((bin) => [bin.lower, bin.density]),
        renderItem: (params: { dataIndex: number }, api: {
          value: (index: number) => number;
          coord: (value: [number, number]) => [number, number];
        }) => {
          const lower = api.value(0);
          const density = api.value(1);
          const upper = histogram.bins[params.dataIndex].upper;
          const upperLeft = api.coord([lower, density]);
          const lowerRight = api.coord([upper, 0]);
          return {
            type: "rect",
            shape: {
              x: upperLeft[0] + 0.5,
              y: upperLeft[1],
              width: Math.max(1, lowerRight[0] - upperLeft[0] - 1),
              height: lowerRight[1] - upperLeft[1],
            },
            style: barStyles[params.dataIndex],
          };
        },
      },
      ...fitSeries,
      ...boxSeries,
      ...specCarrierSeries,
    ],
  };
}

export function buildProcessCapabilityChartOption(
  chart: ProcessCapabilityChartDataV1,
  title: string,
  valueAxisName = "Value",
  densityAxisName = "Probability Density",
): Record<string, unknown> {
  const theme = getGraphTheme();
  const specificationLines: Array<[string, number | null | undefined]> = [
    ["LSL", chart.specificationLines.lsl],
    ["Target", chart.specificationLines.target],
    ["USL", chart.specificationLines.usl],
  ];
  const horizontalSpecificationLines = buildSpecificationMarkLineData(specificationLines, "xAxis", theme);
  const overallPoints = chart.overallDensity.state === "available"
    ? chart.overallDensity.coordinates.map((point) => [point.x, point.y])
    : [];
  const withinPoints = chart.withinDensity?.state === "available"
    ? chart.withinDensity.coordinates.map((point) => [point.x, point.y])
    : [];
  const xValues = [
    ...chart.bins.flatMap((bin) => [bin.lower, bin.upper]),
    ...horizontalSpecificationLines.map((line) => line.xAxis).filter((value): value is number => typeof value === "number"),
    ...overallPoints.map((point) => point[0]),
    ...withinPoints.map((point) => point[0]),
  ];
  const densityValues = [
    0,
    ...chart.bins.map((bin) => bin.density),
    ...overallPoints.map((point) => point[1]),
    ...withinPoints.map((point) => point[1]),
  ];
  const xExtent: [number, number] = [Math.min(...xValues), Math.max(...xValues)];
  const densityExtent: [number, number] = [0, Math.max(...densityValues)];

  return {
    animation: false,
    backgroundColor: "transparent",
    title: { text: title, left: 8, top: 4, textStyle: { color: theme.fgPrimary, fontSize: 12 } },
    grid: { left: 72, right: 40, top: 42, bottom: 54 },
    tooltip: { trigger: "axis" },
    xAxis: {
      ...axis(theme, "value", undefined, xExtent),
      name: valueAxisName,
      nameLocation: "middle",
      nameGap: 30,
    },
    yAxis: {
      ...axis(theme, "value", undefined, densityExtent),
      name: densityAxisName,
      nameLocation: "middle",
      nameGap: 48,
    },
    series: [
      {
        name: "Histogram density",
        type: "custom",
        clip: true,
        data: chart.bins.map((bin) => [bin.lower, bin.density]),
        renderItem: (params: { dataIndex: number }, api: {
          value: (index: number) => number;
          coord: (value: [number, number]) => [number, number];
        }) => {
          const lower = api.value(0);
          const density = api.value(1);
          const bin = chart.bins[params.dataIndex];
          const upper = bin.upper;
          const belowCount = bin.belowCount;
          const aboveCount = bin.aboveCount;
          const upperLeft = api.coord([lower, density]);
          const lowerRight = api.coord([upper, 0]);
          return {
            type: "rect",
            shape: {
              x: upperLeft[0] + 0.5,
              y: upperLeft[1],
              width: Math.max(1, lowerRight[0] - upperLeft[0] - 1),
              height: lowerRight[1] - upperLeft[1],
            },
            style: {
              fill: belowCount > 0 || aboveCount > 0 ? theme.categorical[3] : theme.accent,
              opacity: 0.45,
              stroke: theme.accent,
              lineWidth: 1,
            },
          };
        },
      },
      {
        name: "Overall",
        type: "line",
        clip: true,
        showSymbol: false,
        data: overallPoints,
        lineStyle: { color: theme.fgPrimary, width: 2 },
        markLine: {
          silent: true,
          symbol: "none",
          label: { color: theme.fgSecondary, formatter: "{b}" },
          data: horizontalSpecificationLines,
        },
      },
      {
        name: "Within",
        type: "line",
        clip: true,
        showSymbol: false,
        data: withinPoints,
        lineStyle: { color: theme.accent, width: 1.5, type: "dashed" },
      },
    ],
  };
}

function specificationLineStyle(
  name: string,
  theme: ReturnType<typeof getGraphTheme>,
): { color: string; width: number; type: "solid" | "dashed" | "dotted" } {
  if (name === "Target") {
    return { color: theme.accent, width: 1.5, type: "dashed" };
  }
  if (name === "USL") {
    return { color: theme.categorical[3], width: 1.5, type: "dotted" };
  }
  return { color: theme.categorical[3], width: 1.5, type: "solid" };
}

function buildSpecificationMarkLineData(
  lines: Array<[string, number | null | undefined]>,
  axis: "xAxis" | "yAxis",
  theme: ReturnType<typeof getGraphTheme>,
): Array<{ name: string; xAxis?: number; yAxis?: number; lineStyle: { color: string; width: number; type: "solid" | "dashed" | "dotted" } }> {
  return lines
    .filter((line): line is [string, number] => typeof line[1] === "number" && Number.isFinite(line[1]))
    .map(([name, value]) => ({
      name,
      [axis]: value,
      lineStyle: specificationLineStyle(name, theme),
    }));
}

function axis(
  theme: ReturnType<typeof getGraphTheme>,
  type: "value" | "category",
  data?: string[],
  bounds?: [number, number],
) {
  return {
    type,
    data,
    min: bounds?.[0],
    max: bounds?.[1],
    axisLine: { show: true, lineStyle: { color: theme.axisLine } },
    axisTick: { show: true, lineStyle: { color: theme.axisLine } },
    axisLabel: { color: theme.fgSecondary, fontSize: 10, formatter: formatDistributionAxisLabel },
    splitLine: { show: true, lineStyle: { color: theme.gridLine, type: "dashed" } },
  };
}