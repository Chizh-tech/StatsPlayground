import type {
  ContinuousDistributionIdV1,
  DistributionChartDataV1,
  DistributionCoordinateV1,
  ProcessCapabilityChartDataV1,
} from "@/types/distribution";
import { getGraphTheme } from "./theme";

const FIT_DENSITY_DISTRIBUTION_ORDER: ContinuousDistributionIdV1[] = [
  "normal",
  "lognormal",
  "exponential",
  "gamma",
  "weibull",
];

export interface DistributionFitCurveInputV1 {
  distributionId: ContinuousDistributionIdV1;
  points: DistributionCoordinateV1[];
}

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
): Record<string, unknown> {
  const theme = getGraphTheme();
  const coordinates = boxPlot?.coordinates;
  const specValues = [specificationLines?.lsl, specificationLines?.target, specificationLines?.usl]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const valueExtent = [
    ...histogram.bins.flatMap((bin) => [bin.lower, bin.upper]),
    ...(coordinates ? [coordinates.lowerWhisker, coordinates.upperWhisker, ...coordinates.outliers] : []),
    ...specValues,
  ];
  const valueMin = Math.min(...valueExtent);
  const valueMax = Math.max(...valueExtent);
  const countMax = Math.max(0, ...histogram.bins.map((bin) => bin.count));

  const specMarkLineData: Array<[string, number | null | undefined]> = [
    ["LSL", specificationLines?.lsl],
    ["Target", specificationLines?.target],
    ["USL", specificationLines?.usl],
  ];
  const horizontalSpecMarkLineData = buildSpecificationMarkLineData(specMarkLineData, "yAxis", theme);
  const barStyles = histogram.bins.map(() => ({
    fill: theme.accent,
    opacity: 0.68,
    stroke: theme.accent,
    lineWidth: 1,
  }));
  const specCarrierSeries = horizontalSpecMarkLineData.length > 0
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
            label: { show: true, color: theme.fgSecondary, formatter: "{b}", position: "insideEndTop" },
            data: horizontalSpecMarkLineData,
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
            data: horizontalSpecMarkLineData,
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
          data: coordinates.outliers.map((value) => [0, value]),
          symbolSize: 6,
          itemStyle: { color: theme.accent },
        },
      ]
    : [];

  return {
    animation: false,
    backgroundColor: "transparent",
    title: { text: title, left: 8, top: 4, textStyle: { color: theme.fgPrimary, fontSize: 12 } },
    tooltip: { trigger: "axis" },
    grid: boxPlot
      ? [
          { left: 72, right: 150, top: 42, bottom: 54 },
          { width: 56, right: 40, top: 42, bottom: 54 },
        ]
      : [{ left: 72, right: 40, top: 42, bottom: 54 }],
    xAxis: [
      {
        ...axis(theme, "value", undefined, [0, countMax]),
        gridIndex: 0,
        name: "Count",
        nameLocation: "middle",
        nameGap: 30,
      },
      ...(boxPlot ? [{
        ...axis(theme, "category", [""]),
        gridIndex: 1,
        axisLabel: { show: false },
      }] : []),
    ],
    yAxis: [
      {
        ...axis(theme, "value", undefined, [valueMin, valueMax]),
        gridIndex: 0,
        name: valueAxisName,
        nameLocation: "middle",
        nameGap: 48,
      },
      ...(boxPlot ? [{
        ...axis(theme, "value", undefined, [valueMin, valueMax]),
        gridIndex: 1,
        axisLabel: { show: false },
      }] : []),
    ],
    series: [
      {
        type: "custom",
        clip: true,
        xAxisIndex: 0,
        yAxisIndex: 0,
        data: histogram.bins.map((bin) => [bin.count, bin.lower, bin.upper]),
        renderItem: (_params: { dataIndex: number }, api: {
          value: (index: number) => number;
          coord: (value: [number, number]) => [number, number];
        }) => {
          const count = api.value(0);
          const lower = api.value(1);
          const upper = api.value(2);
          const lowerLeft = api.coord([0, lower]);
          const upperRight = api.coord([count, upper]);
          return {
            type: "rect",
            shape: {
              x: lowerLeft[0],
              y: Math.min(lowerLeft[1], upperRight[1]) + 0.5,
              width: Math.max(0, upperRight[0] - lowerLeft[0]),
              height: Math.max(0, Math.abs(lowerLeft[1] - upperRight[1]) - 1),
            },
            style: barStyles[_params.dataIndex],
          };
        },
      },
      ...boxSeries,
      ...specCarrierSeries,
    ],
  };
}

export function buildDistributionFitDensityOption(
  histogram: Extract<DistributionChartDataV1, { kind: "histogramData" }>,
  curves: DistributionFitCurveInputV1[],
  title: string,
  valueAxisName = "Value",
  densityAxisName = "Probability Density",
): Record<string, unknown> {
  const theme = getGraphTheme();
  const orderedCurves = FIT_DENSITY_DISTRIBUTION_ORDER.flatMap((distributionId) => {
    const curve = curves.find((candidate) => candidate.distributionId === distributionId);
    return curve ? [curve] : [];
  });
  const xValues = [
    ...histogram.bins.flatMap((bin) => [bin.lower, bin.upper]),
    ...orderedCurves.flatMap((curve) => curve.points.map((point) => point.x)),
  ].filter(Number.isFinite);
  const densityValues = [
    0,
    ...histogram.bins.map((bin) => bin.density),
    ...orderedCurves.flatMap((curve) => curve.points.map((point) => point.y)),
  ].filter(Number.isFinite);
  const xExtent: [number, number] = xValues.length > 0
    ? [Math.min(...xValues), Math.max(...xValues)]
    : [0, 1];
  const densityExtent: [number, number] = [0, Math.max(...densityValues)];

  return {
    animation: false,
    backgroundColor: "transparent",
    title: { text: title, left: 8, top: 4, textStyle: { color: theme.fgPrimary, fontSize: 12 } },
    legend: {
      data: orderedCurves.map((curve) => curve.distributionId),
      top: 8,
      right: 40,
      textStyle: { color: theme.fgSecondary },
    },
    grid: { left: 72, right: 40, top: 58, bottom: 54 },
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
        data: histogram.bins.map((bin) => [bin.lower, bin.upper, bin.density]),
        renderItem: (_params: unknown, api: {
          value: (index: number) => number;
          coord: (value: [number, number]) => [number, number];
        }) => {
          const lower = api.value(0);
          const upper = api.value(1);
          const density = api.value(2);
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
            style: { fill: theme.accent, opacity: 0.35, stroke: theme.accent, lineWidth: 1 },
          };
        },
      },
      ...orderedCurves.map((curve) => {
        const colorIndex = FIT_DENSITY_DISTRIBUTION_ORDER.indexOf(curve.distributionId);
        const color = theme.categorical[colorIndex % theme.categorical.length];
        return {
          name: curve.distributionId,
          type: "line",
          clip: true,
          showSymbol: false,
          data: curve.points.map((point) => [point.x, point.y]),
          lineStyle: { color, width: 2 },
          itemStyle: { color },
        };
      }),
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