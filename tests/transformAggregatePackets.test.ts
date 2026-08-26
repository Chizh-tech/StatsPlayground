import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));
import type { GraphTheme } from "../src/graphCore/theme.ts";
import type { GraphData, GraphSpec } from "../src/graphCore/types.ts";
import type { GraphDataFrame } from "../src/types/graphData.ts";

const localStorageState = new Map<string, string>();
const localStorageMock = {
  getItem(key: string): string | null {
    return localStorageState.has(key) ? (localStorageState.get(key) ?? null) : null;
  },
  setItem(key: string, value: string): void {
    localStorageState.set(key, value);
  },
  removeItem(key: string): void {
    localStorageState.delete(key);
  },
  clear(): void {
    localStorageState.clear();
  },
};
Object.defineProperty(globalThis, "localStorage", {
  value: localStorageMock,
  configurable: true,
});

const { buildGraph } = await import("../src/graphCore/transform.ts");
const { drawRawPoints } = await import("../src/graphCore/rawPoints.ts");

{
  const transformSource = readFileSync(resolve(TEST_FILE_DIR, "../src/graphCore/transform.ts"), "utf8");
  assert.match(
    transformSource,
    /function\s+buildBandRefLinesCarrier\([\s\S]*?aggregateMode[\s\S]*?\)/,
    "buildBandRefLinesCarrier must accept explicit aggregate mode context instead of free-variable references",
  );
  assert.match(
    transformSource,
    /function\s+buildAxisOverrides\([\s\S]*?aggregateMode[\s\S]*?\)/,
    "buildAxisOverrides must accept explicit aggregate mode context instead of free-variable references",
  );
}

const theme: GraphTheme = {
  fgPrimary: "#111111",
  fgSecondary: "#333333",
  fgDim: "#666666",
  accent: "#1f77b4",
  gridLine: "#dddddd",
  gridLineMajor: "#bbbbbb",
  axisLine: "#999999",
  bgCanvas: "#ffffff",
  categorical: ["#1f77b4", "#ff7f0e", "#2ca02c", "#d62728"],
  sequential: ["#f0f4ff", "#1f77b4"],
};

function baseData(columns: string[], rows: unknown[][]): GraphData {
  return { columns, rows };
}

function baseFrame(aggregates: GraphDataFrame["aggregates"]): GraphDataFrame {
  return {
    requestId: "req-1",
    datasetId: "ds-1",
    generation: 1,
    sourceRows: 0,
    processedRows: 0,
    sampling: { mode: "full" },
    dictionaries: {},
    extents: {},
    rawChunks: [],
    aggregates,
  };
}

function panelSeries(option: Record<string, unknown>): Array<Record<string, unknown>> {
  const series = option.series;
  if (!Array.isArray(series)) return [];
  return series as Array<Record<string, unknown>>;
}

function throwOnAnyRowAccess(label: string): unknown[][] {
  return new Proxy([] as unknown[][], {
    get() {
      throw new Error(`legacy rows access is forbidden for ${label}`);
    },
  });
}

function frameBackedAggregateData(columns: string[], sourceRows = 4): GraphData {
  return baseData(columns, throwOnAnyRowAccess("frame-backed aggregate packet ownership"));
}

function frameBackedAggregateFrame(aggregates: GraphDataFrame["aggregates"], sourceRows = 4): GraphDataFrame {
  return {
    ...baseFrame(aggregates),
    sourceRows,
    processedRows: sourceRows,
  };
}

function typedNumericFrame(aggregates: GraphDataFrame["aggregates"] = []): GraphDataFrame {
  return {
    ...frameBackedAggregateFrame(aggregates, 6),
    extents: {
      x: { min: 1, max: 6 },
      y: { min: 2, max: 12 },
    },
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 6,
      xValues: new Float64Array([1, 2, 3, 4, 5, 6]),
      yValues: new Float64Array([2, 4, 5, 8, 9, 12]),
      rowIds: new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n]),
      validity: {
        x: new Uint8Array([0b00111111]),
        y: new Uint8Array([0b00111111]),
      },
    }],
  };
}

function typedGroupedNumericFrame(aggregates: GraphDataFrame["aggregates"] = []): GraphDataFrame {
  const frame = typedNumericFrame(aggregates);
  return {
    ...frame,
    dictionaries: { group: ["East", "West"] },
    rawChunks: frame.rawChunks.map((chunk) => ({
      ...chunk,
      groupCodes: new Uint32Array([0, 1, 0, 1, 0, 1]),
      validity: {
        ...chunk.validity,
        group: new Uint8Array([0b00111111]),
      },
    })),
  };
}

function frameScatterValues(panel: { option: unknown }): Array<{
  value: [number | string, number | string];
  __pick?: { rowId: number; colName: string };
}> {
  const scatter = panelSeries(panel.option as Record<string, unknown>)
    .find((entry) => entry.type === "scatter");
  assert.ok(scatter, "expected frame-backed scatter series");
  return scatter.data as Array<{
    value: [number | string, number | string];
    __pick?: { rowId: number; colName: string };
  }>;
}

function typedFacetedNumericFrame(): GraphDataFrame {
  const frame = typedNumericFrame();
  return {
    ...frame,
    dictionaries: { facetX: ["A", "B"] },
    rawChunks: frame.rawChunks.map((chunk) => ({
      ...chunk,
      facetXCodes: new Uint32Array([0, 0, 0, 1, 1, 1]),
      validity: {
        ...chunk.validity,
        facetX: new Uint8Array([0b00111111]),
      },
    })),
  };
}

function typedDateFrame(aggregates: GraphDataFrame["aggregates"] = []): GraphDataFrame {
  return {
    ...frameBackedAggregateFrame(aggregates, 4),
    dictionaries: { x: ["2026-01-01", "2026-01-02"] },
    extents: {
      x: { min: 0, max: 1 },
      y: { min: 2, max: 9 },
    },
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 4,
      xValues: new Uint32Array([0, 0, 1, 1]),
      yValues: new Float64Array([2, 5, 6, 9]),
      rowIds: new BigInt64Array([1n, 2n, 3n, 4n]),
      validity: {
        x: new Uint8Array([0b00001111]),
        y: new Uint8Array([0b00001111]),
      },
    }],
  };
}

for (const mode of ["uniform", "normal"] as const) {
  for (const data of [
    baseData(
      ["_row_id", "category", "value"],
      [[101, "A", 10], [102, "A", 10], [103, "A", 10]],
    ),
    baseData(
      ["category", "value"],
      [["A", 10], ["A", 10], ["A", 10]],
    ),
  ]) {
    const spec: GraphSpec = {
      encoding: {
        x: { name: "category", type: "nominal" },
        y: { name: "value", type: "continuous" },
      },
      elements: [{
        kind: "points",
        enabled: true,
        options: { summaryStat: "none", jitter: mode, jitterLimit: 0.5 },
      }],
    };
    const first = JSON.stringify(buildGraph(spec, data, theme));
    const second = JSON.stringify(buildGraph(spec, data, theme));
    assert.equal(
      second,
      first,
      `repeated legacy ${mode} builds must be identical with ${data.columns.includes("_row_id") ? "row IDs" : "source-index fallback"}`,
    );
  }
}

{
  const data = frameBackedAggregateData(["event_date", "cost"], 4);
  const pointsSpec: GraphSpec = {
    encoding: {
      x: { name: "event_date", type: "datetime" },
      y: { name: "cost", type: "continuous" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };
  const built = buildGraph(pointsSpec, data, theme, undefined, typedDateFrame());
  const panel = built.panels[0];
  assert.ok(panel.rawPoints, "standalone date points must expose a Canvas descriptor");
  const xAxis = panel.option.xAxis as { type?: string; data?: string[] };
  assert.equal(xAxis.type, "time");
  assert.deepEqual(panel.rawPoints?.xCategories, ["2026-01-01", "2026-01-02"]);
  assert.equal(xAxis.data, undefined);
  assert.ok(Number(xAxis.min) <= Date.parse("2026-01-01"));
  assert.ok(Number(xAxis.max) >= Date.parse("2026-01-02"));
  const pointSeries = panelSeries(panel.option as Record<string, unknown>)
    .filter((entry) => entry.type === "scatter");
  assert.equal(pointSeries.length, 1, "frame-backed date points must also emit ECharts scatter");
  const dateValues = (pointSeries[0].data as Array<{ value: [number, number] }>)
    .map((item) => item.value[0]);
  assert.deepEqual(dateValues, [
    Date.parse("2026-01-01"),
    Date.parse("2026-01-01"),
    Date.parse("2026-01-02"),
    Date.parse("2026-01-02"),
  ]);
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "measurement", type: "continuous" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };
  const frame: GraphDataFrame = {
    ...frameBackedAggregateFrame([], 3),
    extents: { x: { min: 11, max: 33 } },
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 3,
      xValues: new Float64Array([11, 22, 33]),
      yValues: new Float64Array([101, 202, 303]),
      rowIds: new BigInt64Array([1n, 2n, 3n]),
      validity: {
        x: new Uint8Array([0b00000111]),
        y: new Uint8Array([0b00000111]),
      },
    }],
  };

  const items = frameScatterValues(buildGraph(
    spec,
    frameBackedAggregateData(["measurement"], 3),
    theme,
    undefined,
    frame,
  ).panels[0]);
  assert.deepEqual(items.map((item) => item.value), [[11, ""], [22, ""], [33, ""]]);
  assert.ok(items.every((item) => item.__pick?.colName === "measurement"));
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "measurement", type: "continuous" },
      y: { name: "region", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };
  const frame: GraphDataFrame = {
    ...frameBackedAggregateFrame([], 4),
    dictionaries: { y: ["East", "West"] },
    extents: { x: { min: 10, max: 40 } },
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 4,
      xValues: new Float64Array([10, 20, 30, 40]),
      yValues: new Float64Array([0, 1, 0, 1]),
      rowIds: new BigInt64Array([11n, 12n, 13n, 14n]),
      validity: {
        x: new Uint8Array([0b00001111]),
        y: new Uint8Array([0b00001111]),
      },
    }],
  };

  const items = frameScatterValues(buildGraph(
    spec,
    frameBackedAggregateData(["measurement", "region"], 4),
    theme,
    { region: ["East", "West"] },
    frame,
  ).panels[0]);
  assert.deepEqual(items.map((item) => item.value), [
    [10, "East"],
    [20, "West"],
    [30, "East"],
    [40, "West"],
  ]);
  assert.ok(items.every((item) => item.__pick?.colName === "measurement"));
}

{
  const data = frameBackedAggregateData(["event_date", "cost"], 4);
  const boxPacket: GraphDataFrame["aggregates"][number] = {
    kind: "boxPlot",
    xColumn: "event_date",
    yColumn: "cost",
    entries: [
      {
        category: "2026-01-01",
        count: 2,
        min: 2,
        q1: 2.5,
        median: 3.5,
        q3: 4.5,
        max: 5,
        whiskerLow: 2,
        whiskerHigh: 5,
        outliers: [],
      },
      {
        category: "2026-01-02",
        count: 2,
        min: 6,
        q1: 6.5,
        median: 7.5,
        q3: 8.5,
        max: 9,
        whiskerLow: 6,
        whiskerHigh: 9,
        outliers: [],
      },
    ],
  };
  const spec: GraphSpec = {
    encoding: {
      x: { name: "event_date", type: "datetime" },
      y: { name: "cost", type: "continuous" },
    },
    elements: [
      { kind: "points", enabled: true, options: { summaryStat: "none" } },
      { kind: "boxplot", enabled: true },
    ],
  };
  const panel = buildGraph(spec, data, theme, undefined, typedDateFrame([boxPacket])).panels[0];
  assert.ok(panel.rawPoints, "points + boxplot must retain the Canvas points layer");
  assert.ok(panelSeries(panel.option as Record<string, unknown>).some((entry) => entry.type === "boxplot"));
}

for (const element of [
  { kind: "line", enabled: true, options: { summaryStat: "none" } },
  { kind: "bar", enabled: true },
  { kind: "smoother", enabled: true },
  { kind: "fitline", enabled: true, options: { degree: 1 } },
] satisfies GraphSpec["elements"]) {
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
    },
    elements: [element],
  };
  const series = panelSeries(
    buildGraph(spec, frameBackedAggregateData(["x", "y"], 6), theme, undefined, typedNumericFrame())
      .panels[0].option as Record<string, unknown>,
  );
  assert.ok(series.length > 0, `frame-backed ${element.kind} must emit a renderable series`);
  assert.ok(series.some((entry) => Array.isArray(entry.data) && entry.data.length > 0));
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      color: { name: "region", type: "nominal" },
    },
    elements: [{ kind: "line", enabled: true, options: { summaryStat: "none" } }],
  };
  const series = panelSeries(
    buildGraph(
      spec,
      frameBackedAggregateData(["x", "y", "region"], 6),
      theme,
      undefined,
      typedGroupedNumericFrame(),
    ).panels[0].option as Record<string, unknown>,
  ).filter((entry) => entry.type === "line");
  assert.deepEqual(series.map((entry) => entry.name), ["East", "West"]);
  assert.ok(series.every((entry) => Array.isArray(entry.data) && entry.data.length === 3));
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      color: { name: "region", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
    hiddenGroups: ["West"],
    styles: {
      East: { point: { color: "#123456", markerSize: 8, opacity: 1 } },
    },
  };
  const panel = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y", "region"], 6),
    theme,
    undefined,
    typedGroupedNumericFrame(),
  ).panels[0];
  assert.equal(panel.rawPoints?.groupColors?.[0], "rgba(18, 52, 86, 1)");
  assert.match(panel.rawPoints?.groupColors?.[1] ?? "", /^rgba\(/);
  assert.deepEqual(panel.rawPoints?.groupPointSizes, [8, 4]);
  assert.deepEqual(Array.from(panel.rawPoints?.hiddenGroupCodes ?? []), [1]);
  assert.ok(panel.rawPoints?.chunks.every((chunk) => chunk.groupCodes instanceof Uint32Array));
  const pointSeries = panelSeries(panel.option as Record<string, unknown>)
    .filter((entry) => entry.type === "scatter");
  assert.deepEqual(pointSeries.map((entry) => entry.name), ["East"]);
  assert.equal(pointSeries[0].symbol, "circle");
  assert.equal(pointSeries[0].symbolSize, 8);
  assert.equal(pointSeries[0].progressive, 0);
  assert.notEqual(pointSeries[0].large, true);
  assert.deepEqual(pointSeries[0].itemStyle, {
    color: "#123456",
    borderColor: "#123456",
    opacity: 1,
  });
  const pointItems = pointSeries[0].data as Array<{
    value: [number, number];
    symbolOffset: [number, number];
    __pick: { rowId: number; colName: string };
  }>;
  assert.equal(pointItems.length, 3);
  assert.ok(pointItems.every((item) => item.__pick.colName === "y"));
  assert.ok(pointItems.every((item) => Array.isArray(item.symbolOffset)));
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      color: { name: "region", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
    hiddenGroups: ["West"],
  };
  const rows = [
    [1, 10, "East"],
    [2, 20, "East"],
    [-1000, -2000, "West"],
    [1000, 2000, "West"],
  ];
  const frame: GraphDataFrame = {
    ...frameBackedAggregateFrame([], 4),
    dictionaries: { group: ["East", "West"] },
    extents: {
      x: { min: -1000, max: 1000 },
      y: { min: -2000, max: 2000 },
    },
    rawChunks: [{
      chunkIndex: 0,
      rowOffset: 0,
      rowCount: 4,
      xValues: new Float64Array([1, 2, -1000, 1000]),
      yValues: new Float64Array([10, 20, -2000, 2000]),
      rowIds: new BigInt64Array([1n, 2n, 3n, 4n]),
      groupCodes: new Uint32Array([0, 0, 1, 1]),
      validity: {
        x: new Uint8Array([0b00001111]),
        y: new Uint8Array([0b00001111]),
        group: new Uint8Array([0b00001111]),
      },
    }],
  };
  const legacyPanel = buildGraph(
    spec,
    baseData(["x", "y", "region"], rows),
    theme,
    { region: ["East", "West"] },
  ).panels[0];
  const framePanel = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y", "region"], 4),
    theme,
    { region: ["East", "West"] },
    frame,
  ).panels[0];
  const legacyXAxis = legacyPanel.option.xAxis as { min?: number; max?: number };
  const legacyYAxis = legacyPanel.option.yAxis as { min?: number; max?: number };
  const frameXAxis = framePanel.option.xAxis as { min?: number; max?: number };
  const frameYAxis = framePanel.option.yAxis as { min?: number; max?: number };
  assert.deepEqual(
    { min: frameXAxis.min, max: frameXAxis.max },
    { min: legacyXAxis.min, max: legacyXAxis.max },
    "frame-backed point-only X bounds must match legacy hidden-group filtering",
  );
  assert.deepEqual(
    { min: frameYAxis.min, max: frameYAxis.max },
    { min: legacyYAxis.min, max: legacyYAxis.max },
    "frame-backed point-only Y bounds must match legacy hidden-group filtering",
  );
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      color: { name: "region", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
    hiddenGroups: ["East"],
  };
  const panel = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y", "region"], 6),
    theme,
    undefined,
    typedGroupedNumericFrame(),
  ).panels[0];
  const pointSeries = panelSeries(panel.option as Record<string, unknown>)
    .filter((entry) => entry.type === "scatter");
  assert.deepEqual(pointSeries.map((entry) => entry.name), ["West"]);
  assert.equal(
    (pointSeries[0].itemStyle as { color?: string }).color,
    "#cc660b",
    "hidden groups must not shift later groups into an earlier palette slot",
  );
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
    },
    elements: [{
      kind: "points",
      enabled: true,
      options: { summaryStat: "none", jitter: "normal", jitterLimit: 0.75 },
    }],
  };
  const panel = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y"], 6),
    theme,
    undefined,
    typedNumericFrame(),
  ).panels[0];
  assert.deepEqual(panel.rawPoints?.jitter, { mode: "normal", limit: 0.75 });
}

{
  const summaryPacket: GraphDataFrame["aggregates"][number] = {
    kind: "summary",
    xColumn: "x",
    yColumn: "y",
    summaries: [{
      category: "1",
      count: 6,
      mean: 6.67,
      median: 6.5,
      stddev: 3.6,
      min: 2,
      max: 12,
    }],
  };
  for (const kind of ["points", "line"] as const) {
    const spec: GraphSpec = {
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
      },
      elements: [{ kind, enabled: true, options: { summaryStat: "mean", errorInterval: "none" } }],
    };
    const series = panelSeries(
      buildGraph(
        spec,
        frameBackedAggregateData(["x", "y"], 6),
        theme,
        undefined,
        typedNumericFrame([summaryPacket]),
      ).panels[0].option as Record<string, unknown>,
    );
    assert.ok(series.length > 0, `summary packet must render standalone ${kind}`);
  }
}

{
  const overlayElements: GraphSpec["elements"] = [
    { kind: "points", enabled: true, options: { summaryStat: "none" } },
    { kind: "line", enabled: true, options: { summaryStat: "none" } },
    { kind: "bar", enabled: true },
    { kind: "smoother", enabled: true },
    { kind: "fitline", enabled: true, options: { degree: 1 } },
  ];
  for (const overlay of overlayElements.slice(1)) {
    const spec: GraphSpec = {
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
      },
      elements: [overlayElements[0], overlay],
    };
    const panel = buildGraph(
      spec,
      frameBackedAggregateData(["x", "y"], 6),
      theme,
      undefined,
      typedNumericFrame(),
    ).panels[0];
    assert.ok(panel.rawPoints, `points + ${overlay.kind} must retain Canvas points`);
    assert.ok(
      panelSeries(panel.option as Record<string, unknown>).some(
        (entry) => Array.isArray(entry.data) && entry.data.length > 0,
      ),
      `points + ${overlay.kind} must emit the overlay series`,
    );
  }
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      groupX: { name: "panel", type: "nominal" },
    },
    elements: [{ kind: "line", enabled: true, options: { summaryStat: "none" } }],
  };
  const built = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y", "panel"], 6),
    theme,
    undefined,
    typedFacetedNumericFrame(),
  );
  assert.equal(built.panels.length, 2);
  for (const panel of built.panels) {
    const line = panelSeries(panel.option as Record<string, unknown>).find((entry) => entry.type === "line");
    assert.ok(line);
    assert.equal((line?.data as unknown[]).length, 3, `facet ${panel.title} must contain only its rows`);
  }
}

{
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      groupX: { name: "panel", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };
  const built = buildGraph(
    spec,
    frameBackedAggregateData(["x", "y", "panel"], 6),
    theme,
    undefined,
    typedFacetedNumericFrame(),
  );
  assert.equal(built.panels.length, 2);
  for (const panel of built.panels) {
    const scatter = panelSeries(panel.option as Record<string, unknown>)
      .find((entry) => entry.type === "scatter");
    assert.ok(scatter, `facet ${panel.title} must emit frame-backed scatter`);
    assert.equal((scatter.data as unknown[]).length, 3, `facet ${panel.title} must contain only its points`);
    assert.ok(panel.rawPoints, `facet ${panel.title} must retain Canvas output until Task 3`);
  }
}

{
  const packetOverlays: Array<{
    name: string;
    element: GraphSpec["elements"][number];
    packet: GraphDataFrame["aggregates"][number];
    seriesType: string;
  }> = [
    {
      name: "histogram",
      element: { kind: "histogram", enabled: true, options: { histStyle: "bar" } },
      packet: {
        kind: "histogram",
        xColumn: "x",
        yColumn: "y",
        binCount: 2,
        minValue: 0,
        maxValue: 12,
        missingCount: 0,
        binWidth: 6,
        totalCount: 6,
        bins: [
          { binStart: 0, binEnd: 6, count: 3 },
          { binStart: 6, binEnd: 12, count: 3 },
        ],
      },
      seriesType: "bar",
    },
    {
      name: "heatmap",
      element: { kind: "heatmap", enabled: true },
      packet: {
        kind: "heatmap",
        xColumn: "x",
        yColumn: "y",
        xBinCount: 1,
        yBinCount: 1,
        xMin: 1,
        xMax: 6,
        yMin: 2,
        yMax: 12,
        missingCount: 0,
        xBinWidth: 5,
        yBinWidth: 10,
        totalCount: 6,
        cells: [{
          xBinIndex: 0,
          yBinIndex: 0,
          xBinStart: 1,
          xBinEnd: 6,
          yBinStart: 2,
          yBinEnd: 12,
          count: 6,
        }],
      },
      seriesType: "heatmap",
    },
  ];
  for (const overlay of packetOverlays) {
    const spec: GraphSpec = {
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
      },
      elements: [
        { kind: "points", enabled: true, options: { summaryStat: "none" } },
        overlay.element,
      ],
    };
    const panel = buildGraph(
      spec,
      frameBackedAggregateData(["x", "y"], 6),
      theme,
      undefined,
      typedNumericFrame([overlay.packet]),
    ).panels[0];
    assert.ok(panel.rawPoints, `points + ${overlay.name} must retain Canvas points`);
    assert.ok(
      panelSeries(panel.option as Record<string, unknown>).some(
        (entry) => entry.type === overlay.seriesType && Array.isArray(entry.data) && entry.data.length > 0,
      ),
      `points + ${overlay.name} must emit the packet overlay`,
    );
    const xAxis = panel.option.xAxis as { min?: number; max?: number };
    const yAxis = panel.option.yAxis as { min?: number; max?: number };
    assert.deepEqual(
      { min: xAxis.min, max: xAxis.max },
      { min: 1, max: 6 },
      `points + ${overlay.name} must preserve the complete frame X extent`,
    );
    if (overlay.name === "heatmap") {
      assert.deepEqual(
        { min: yAxis.min, max: yAxis.max },
        { min: 2, max: 12 },
        "points + heatmap must preserve the complete frame Y extent",
      );
    }
  }
}

{
  const throwingRows = new Proxy([] as unknown[][], {
    get(_target, prop) {
      if (prop === "length") return 2;
      throw new Error("frame-backed panel descriptor must not read legacy rows");
    },
  });

  const data = baseData(["x", "y", "wrapCol"], throwingRows);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      wrap: { name: "wrapCol", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };

  const frame: GraphDataFrame = {
    requestId: "req-wrap-roles",
    datasetId: "ds-wrap-roles",
    generation: 1,
    sourceRows: 2,
    processedRows: 2,
    sampling: { mode: "full" },
    dictionaries: {
      source: ["m2", "m1"],
      wrap: ["W1", "W2"],
    },
    extents: {},
    aggregates: [],
    rawChunks: [
      {
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 2,
        xValues: new Float64Array([1, 2]),
        yValues: new Float64Array([10, 20]),
        rowIds: new BigInt64Array([101n, 102n]),
        roleVectors: {
          source: new Uint32Array([1, 0]),
          wrap: new Uint32Array([0, 1]),
        },
        validity: {
          x: new Uint8Array([0b00000011]),
          y: new Uint8Array([0b00000011]),
          source: new Uint8Array([0b00000001]),
          wrap: new Uint8Array([0b00000011]),
        },
      },
    ],
  };

  const built = buildGraph(spec, data, theme, undefined, frame);
  const wrapPanel = built.panels.find((panel) => panel.title.includes("W2"));
  assert.ok(wrapPanel, "expected wrapped panel for W2 facet value");

  const sourceByRowId = wrapPanel?.rawPoints?.sourceByRowId;
  assert.equal(sourceByRowId?.get(101n), "m1");
  assert.equal(sourceByRowId?.get(102n), undefined, "invalid source rows must not receive melt provenance");

  const facetMask = wrapPanel?.rawPoints?.chunks[0]?.facetMask;
  assert.ok(facetMask, "facet mask must be emitted for wrapped panel");
  assert.equal(facetMask?.[0], 0b00000010);
  const scatter = panelSeries(wrapPanel?.option as Record<string, unknown>)
    .find((entry) => entry.type === "scatter");
  assert.ok(scatter);
  const scatterItems = scatter.data as Array<{ __pick?: { rowId: number; colName: string } }>;
  assert.deepEqual(scatterItems.map((item) => item.__pick), [
    { rowId: 102, colName: "y" },
  ]);
}

{
  const throwingRows = new Proxy([] as unknown[][], {
    get(_target, prop) {
      if (prop === "length") return 10;
      throw new Error("frame-backed descriptor must not read legacy rows in cross-byte test");
    },
  });

  const data = baseData(["x", "y", "wrapCol"], throwingRows);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      wrap: { name: "wrapCol", type: "nominal" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };

  const frame: GraphDataFrame = {
    requestId: "req-wrap-cross-byte",
    datasetId: "ds-wrap-cross-byte",
    generation: 1,
    sourceRows: 10,
    processedRows: 10,
    sampling: { mode: "full" },
    dictionaries: {
      source: ["m1", "m2"],
      wrap: ["W1", "W2"],
    },
    extents: {},
    aggregates: [],
    rawChunks: [
      {
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 10,
        xValues: new Float64Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]),
        yValues: new Float64Array([10, 20, 30, 40, 50, 60, 70, 80, 90, 100]),
        rowIds: new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]),
        roleVectors: {
          source: new Uint32Array([0, 1, 0, 1, 0, 1, 0, 1, 1, 0]),
          wrap: new Uint32Array([0, 1, 0, 1, 0, 1, 0, 1, 1, 0]),
        },
        validity: {
          x: new Uint8Array([0b00000011, 0b00000011]),
          y: new Uint8Array([0b00000011, 0b00000011]),
          source: new Uint8Array([0b00000001, 0b00000001]),
          wrap: new Uint8Array([0b00000001, 0b00000001]),
        },
      },
    ],
  };

  const built = buildGraph(spec, data, theme, undefined, frame);
  const wrapPanel = built.panels.find((panel) => panel.title.includes("W2"));
  assert.ok(wrapPanel, "expected wrapped panel for cross-byte wrap value");

  const sourceByRowId = wrapPanel?.rawPoints?.sourceByRowId;
  assert.equal(sourceByRowId?.get(9n), "m2");
  assert.equal(sourceByRowId?.get(10n), undefined);

  const facetMask = wrapPanel?.rawPoints?.chunks[0]?.facetMask;
  assert.ok(facetMask);
  assert.equal(facetMask?.[1] & 0b00000001, 0b00000001);
}

{
  const data = baseData(["cat", "v"], []);
  const frame = baseFrame([
    {
      kind: "histogram",
      xColumn: "cat",
      yColumn: "v",
      groupColumn: "cat",
      sourceColumn: "__sp_variable__",
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 3,
      bins: [
        { category: "A", binStart: 0, binEnd: 1, count: 2 },
        { category: "B", binStart: 1, binEnd: 2, count: 1 },
      ],
    },
  ]);

  for (const histStyle of ["bar", "polygon", "kde", "shadowgram"]) {
    const spec: GraphSpec = {
      encoding: {
        x: { name: "cat", type: "nominal" },
        y: { name: "v", type: "continuous" },
      },
      elements: [{ kind: "histogram", enabled: true, options: { histStyle } }],
    };

    const built = buildGraph(spec, data, theme, undefined, frame);
    const series = panelSeries(built.panels[0].option as Record<string, unknown>);
    assert.ok(series.length > 0, `histogram style ${histStyle} should be emitted from packet data even when rows are empty`);
  }
}

{
  const throwingRows = new Proxy([] as unknown[][], {
    get(target, prop, receiver) {
      if (prop === "length") return 0;
      if (
        prop === "map" ||
        prop === "forEach" ||
        prop === "filter" ||
        prop === "some" ||
        prop === Symbol.iterator
      ) {
        return () => {
          throw new Error("legacy rows access is forbidden for packet-backed histogram");
        };
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const data = baseData(["cat", "v"], throwingRows);
  const frame = baseFrame([
    {
      kind: "histogram",
      xColumn: "cat",
      yColumn: "v",
      groupColumn: null,
      sourceColumn: null,
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 3,
      bins: [
        { category: "A", binStart: 0, binEnd: 1, count: 2 },
        { category: "B", binStart: 1, binEnd: 2, count: 1 },
      ],
    },
  ]);

  for (const histStyle of ["bar", "polygon", "kde", "shadowgram"]) {
    const spec: GraphSpec = {
      encoding: {
        x: { name: "cat", type: "nominal" },
        y: { name: "v", type: "continuous" },
      },
      elements: [{ kind: "histogram", enabled: true, options: { histStyle } }],
    };

    const built = buildGraph(spec, data, theme, undefined, frame);
    const series = panelSeries(built.panels[0].option as Record<string, unknown>);
    assert.ok(series.length > 0, `packet-backed histogram style ${histStyle} should render with unavailable legacy rows`);
    const fallbackSeries = series.filter((entry) => String(entry.id ?? "").startsWith("__hist_packet_fallback_"));
    assert.equal(
      fallbackSeries.length,
      0,
      `packet-backed histogram style ${histStyle} must emit its native style series instead of fallback bars`,
    );
    assert.ok(
      series.some((entry) => String(entry.id ?? "").startsWith("__hist_cat_")),
      `packet-backed histogram style ${histStyle} should emit category histogram series ids`,
    );
  }
}

{
  const inaccessibleRows = new Proxy([] as unknown[][], {
    get(target, prop, receiver) {
      if (
        prop === "length" ||
        prop === Symbol.iterator ||
        prop === "map" ||
        prop === "forEach" ||
        prop === "filter" ||
        prop === "some"
      ) {
        throw new Error("frame-backed histogram must not access legacy rows when packet extents are malformed");
      }
      return Reflect.get(target, prop, receiver);
    },
  });

  const data = baseData(["cat", "v"], inaccessibleRows);
  const frame = baseFrame([
    {
      kind: "histogram",
      xColumn: "cat",
      yColumn: "v",
      groupColumn: null,
      sourceColumn: null,
      binCount: 2,
      minValue: Number.NaN,
      maxValue: Number.NaN,
      missingCount: 0,
      binWidth: Number.NaN,
      totalCount: 2,
      bins: [
        { category: "A", binStart: Number.NaN, binEnd: Number.NaN, count: 1 },
        { category: "B", binStart: Number.NaN, binEnd: Number.NaN, count: 1 },
      ],
    },
  ]);

  const spec: GraphSpec = {
    encoding: {
      x: { name: "cat", type: "nominal" },
      y: { name: "v", type: "continuous" },
    },
    elements: [{ kind: "histogram", enabled: true, options: { histStyle: "bar" } }],
  };

  assert.doesNotThrow(() => {
    buildGraph(spec, data, theme, undefined, frame);
  }, "malformed frame-backed histogram extents must not trigger legacy rows fallback reads");
}

{
  const data = baseData(["x", "v", "grp"], []);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "v", type: "continuous" },
      color: { name: "grp", type: "nominal" },
    },
    hiddenGroups: ["G"],
    elements: [{ kind: "histogram", enabled: true, options: { histStyle: "bar" } }],
  };

  const nonEmptyFrame = baseFrame([
    {
      kind: "histogram",
      xColumn: "x",
      yColumn: "v",
      groupColumn: "grp",
      sourceColumn: null,
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 3,
      bins: [
        { group: "G", binStart: 0, binEnd: 1, count: 2 },
        { group: "G", binStart: 1, binEnd: 2, count: 1 },
      ],
    },
  ]);

  const nonEmptyBuilt = buildGraph(spec, data, theme, undefined, nonEmptyFrame);
  const nonEmptySeries = panelSeries(nonEmptyBuilt.panels[0].option as Record<string, unknown>);
  assert.equal(
    nonEmptySeries.some((entry) => String(entry.id ?? "").startsWith("__hist_packet_fallback_mode_a")),
    false,
    "non-empty packet must not synthesize mode-A fallback series",
  );

  const emptyFrame = baseFrame([
    {
      kind: "histogram",
      xColumn: "x",
      yColumn: "v",
      groupColumn: "grp",
      sourceColumn: null,
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 0,
      bins: [
        { group: "G", binStart: 0, binEnd: 1, count: 2 },
        { group: "G", binStart: 1, binEnd: 2, count: 1 },
      ],
    },
  ]);

  const emptyBuilt = buildGraph(spec, data, theme, undefined, emptyFrame);
  const emptySeries = panelSeries(emptyBuilt.panels[0].option as Record<string, unknown>);
  assert.equal(
    emptySeries.some((entry) => String(entry.id ?? "").startsWith("__hist_packet_fallback_mode_a")),
    true,
    "empty packet may synthesize mode-A fallback series",
  );
}

{
  const data = baseData(["cat", "v", "grp"], []);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "cat", type: "nominal" },
      y: { name: "v", type: "continuous" },
      color: { name: "grp", type: "nominal" },
    },
    hiddenGroups: ["__all__"],
    elements: [
      { kind: "histogram", enabled: true, options: { histStyle: "bar" } },
      { kind: "points", enabled: true, options: { summaryStat: "mean" } },
    ],
  };

  const nonEmptyFrame = baseFrame([
    {
      kind: "histogram",
      xColumn: "cat",
      yColumn: "v",
      groupColumn: "grp",
      sourceColumn: null,
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 3,
      bins: [
        { category: "A", binStart: 0, binEnd: 1, count: 2 },
        { category: "B", binStart: 1, binEnd: 2, count: 1 },
      ],
    },
    {
      kind: "summary",
      xColumn: "cat",
      yColumn: "v",
      groupColumn: "grp",
      sourceColumn: null,
      summaries: [
        {
          category: "A",
          group: "S",
          count: 1,
          mean: 1,
          median: 1,
          stddev: 0,
          min: 1,
          max: 1,
        },
      ],
    },
  ]);

  const nonEmptyBuilt = buildGraph(spec, data, theme, undefined, nonEmptyFrame);
  const nonEmptySeries = panelSeries(nonEmptyBuilt.panels[0].option as Record<string, unknown>);
  assert.equal(
    nonEmptySeries.some((entry) => String(entry.id ?? "").startsWith("__hist_packet_fallback_final_")),
    false,
    "non-empty packet must not synthesize final histogram fallback series",
  );
}

{
  const data = baseData(["x", "y"], []);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
    },
    elements: [{ kind: "histogram", enabled: true, options: { histStyle: "bar" } }],
  };

  const frame = baseFrame([
    {
      kind: "histogram",
      xColumn: "x",
      yColumn: "y",
      binCount: 2,
      minValue: 0,
      maxValue: 2,
      missingCount: 0,
      binWidth: 1,
      totalCount: 3,
      bins: [
        { binStart: 0, binEnd: 1, count: 2 },
        { binStart: 1, binEnd: 2, count: 1 },
      ],
    },
  ]);

  const built = buildGraph(spec, data, theme, undefined, frame);
  const series = panelSeries(built.panels[0].option as Record<string, unknown>);
  assert.ok(series.length > 0, "mode A histogram should be emitted from packet bins when rows are empty");
}

{
  const matrix: Array<{
    name: string;
    data: GraphData;
    spec: GraphSpec;
    frame: GraphDataFrame;
    verify: (series: Array<Record<string, unknown>>) => void;
  }> = [
    {
      name: "histogram packet",
      data: frameBackedAggregateData(["x", "y"]),
      spec: {
        encoding: {
          x: { name: "x", type: "continuous" },
          y: { name: "y", type: "continuous" },
        },
        elements: [{ kind: "histogram", enabled: true, options: { histStyle: "bar" } }],
      },
      frame: frameBackedAggregateFrame([
        {
          kind: "histogram",
          xColumn: "x",
          yColumn: "y",
          binCount: 2,
          minValue: 0,
          maxValue: 2,
          missingCount: 0,
          binWidth: 1,
          totalCount: 3,
          bins: [
            { binStart: 0, binEnd: 1, count: 2 },
            { binStart: 1, binEnd: 2, count: 1 },
          ],
        },
      ]),
      verify: (series) => {
        assert.ok(series.length > 0, "frame-backed histogram packet should produce renderable series");
      },
    },
    {
      name: "heatmap packet",
      data: frameBackedAggregateData(["x", "y"]),
      spec: {
        encoding: {
          x: { name: "x", type: "continuous" },
          y: { name: "y", type: "continuous" },
        },
        elements: [{ kind: "heatmap" as any, enabled: true }],
      },
      frame: frameBackedAggregateFrame([
        {
          kind: "heatmap",
          xColumn: "x",
          yColumn: "y",
          xBinCount: 2,
          yBinCount: 2,
          xMin: 0,
          xMax: 2,
          yMin: 0,
          yMax: 2,
          missingCount: 0,
          xBinWidth: 1,
          yBinWidth: 1,
          totalCount: 3,
          cells: [
            { xBinIndex: 0, yBinIndex: 0, xBinStart: 0, xBinEnd: 1, yBinStart: 0, yBinEnd: 1, count: 2 },
            { xBinIndex: 1, yBinIndex: 1, xBinStart: 1, xBinEnd: 2, yBinStart: 1, yBinEnd: 2, count: 1 },
          ],
        },
      ]),
      verify: (series) => {
        const heatSeries = series.find((entry) => entry.type === "heatmap" || entry.type === "custom");
        assert.ok(heatSeries, "heatmap packet should produce a renderable series");
        const points = Array.isArray(heatSeries?.data) ? (heatSeries?.data as unknown[][]) : [];
        assert.ok(
          points.some((row) => Number(row[0]) === 0.5 && Number(row[1]) === 0.5 && Number(row[2]) === 2),
          "heatmap packet cell center/count must map to heatmap series data",
        );
      },
    },
    {
      name: "boxplot missing packet",
      data: frameBackedAggregateData(["x", "y"]),
      spec: {
        encoding: {
          x: { name: "x", type: "nominal" },
          y: { name: "y", type: "continuous" },
        },
        elements: [{ kind: "boxplot", enabled: true }],
      },
      frame: frameBackedAggregateFrame([]),
      verify: (series) => {
        assert.equal(
          series.some((entry) => entry.type === "boxplot"),
          false,
          "frame-backed boxplot must not fall back to row scan when packet is missing",
        );
      },
    },
    {
      name: "grouped boxplot packet",
      data: frameBackedAggregateData(["event_date", "cost", "region"], 300_000),
      spec: {
        encoding: {
          x: { name: "event_date", type: "datetime" },
          y: { name: "cost", type: "continuous" },
          color: { name: "region", type: "nominal" },
        },
        elements: [{ kind: "boxplot", enabled: true }],
      },
      frame: {
        ...frameBackedAggregateFrame([
          {
            kind: "boxPlot",
            xColumn: "event_date",
            yColumn: "cost",
            groupColumn: "region",
            entries: [
              {
                group: "East",
                category: "2026-01-01",
                count: 10,
                min: 1,
                q1: 2,
                median: 3,
                q3: 4,
                max: 5,
                whiskerLow: 1,
                whiskerHigh: 5,
                outliers: [],
              },
              {
                group: "West",
                category: "2026-01-01",
                count: 8,
                min: 2,
                q1: 3,
                median: 4,
                q3: 5,
                max: 6,
                whiskerLow: 2,
                whiskerHigh: 6,
                outliers: [],
              },
            ],
          },
        ], 300_000),
        dictionaries: { group: ["East", "West"] },
      },
      verify: (series) => {
        const boxes = series.filter((entry) => entry.type === "boxplot");
        assert.equal(boxes.length, 2, "packet groups must each produce a boxplot series");
        assert.deepEqual(boxes.map((entry) => entry.name), ["East", "West"]);
        assert.deepEqual(boxes.map((entry) => entry.data), [
          [[1, 2, 3, 4, 5]],
          [[2, 3, 4, 5, 6]],
        ]);
      },
    },
    {
      name: "summary missing packet",
      data: frameBackedAggregateData(["x", "y"]),
      spec: {
        encoding: {
          x: { name: "x", type: "nominal" },
          y: { name: "y", type: "continuous" },
        },
        elements: [{ kind: "points", enabled: true, options: { summaryStat: "mean" } }],
      },
      frame: frameBackedAggregateFrame([]),
      verify: (series) => {
        assert.equal(
          series.some((entry) => String(entry.id ?? "").endsWith("__summary")),
          false,
          "frame-backed summary points must not be derived from row scan when summary packet is missing",
        );
      },
    },
  ];

  for (const testCase of matrix) {
    assert.doesNotThrow(
      () => {
        const built = buildGraph(testCase.spec, testCase.data, theme, undefined, testCase.frame);
        const series = panelSeries(built.panels[0].option as Record<string, unknown>);
        testCase.verify(series);
      },
      `${testCase.name} must not reconstruct legacy rows for frame-backed packet ownership`,
    );
  }
}

{
  const throwingRows = new Proxy([] as unknown[][], {
    get(_target, prop) {
      if (prop === "length") return 0;
      throw new Error("legacy rows access is forbidden for typed melt-source mapping");
    },
  });

  const data = baseData(["_row_id", "cat", "__sp_value__", "__sp_variable__"], throwingRows);

  const spec: GraphSpec = {
    encoding: {
      x: { name: "cat", type: "nominal" },
      y: { name: "__sp_value__", type: "continuous" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "none" } }],
  };

  const frame: GraphDataFrame = {
    ...baseFrame([]),
    dictionaries: { x: ["A"], source: ["m1", "m2"] },
    rawChunks: [
      {
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 2,
        xValues: new Uint32Array([0, 0]),
        yValues: new Float64Array([10, 11]),
        rowIds: new BigInt64Array([1n, 2n]),
        sourceCodes: new Uint32Array([0, 1]),
        validity: {
          x: new Uint8Array([0b00000011]),
          y: new Uint8Array([0b00000011]),
          source: new Uint8Array([0b00000011]),
        },
      },
    ],
  };

  const built = buildGraph(spec, data, theme, undefined, frame);
  const descriptor = built.panels[0].rawPoints;
  assert.ok(descriptor, "raw descriptor should exist for non-summary points");

  const drawn = drawRawPoints(descriptor!, {
    plotRect: { x: 0, y: 0, width: 64, height: 64 },
    x: { kind: "categorical", pixelsByCategory: new Float64Array([10]) },
    y: { kind: "numeric", scale: -1, offset: 32 },
  });

  const colNames = new Set(drawn.points.map((point) => point.colName));
  assert.deepEqual(colNames, new Set(["m1", "m2"]), "raw point picks must preserve typed melted source identity from source codes");
}

{
  const throwingRows = new Proxy([] as unknown[][], {
    get(_target, prop) {
      if (prop === "length") return 0;
      throw new Error("legacy rows access is forbidden for frame-backed facets");
    },
  });

  const data = baseData(["cat", "v"], throwingRows);
  const frame: GraphDataFrame = {
    ...baseFrame([
      {
        kind: "histogram",
        xColumn: "cat",
        yColumn: "v",
        binCount: 1,
        minValue: 0,
        maxValue: 1,
        missingCount: 0,
        binWidth: 1,
        totalCount: 4,
        bins: [
          { category: "A", facetX: "L", facetY: "Top", binStart: 0, binEnd: 1, count: 1 },
          { category: "A", facetX: "R", facetY: "Top", binStart: 0, binEnd: 1, count: 1 },
          { category: "A", facetX: "L", facetY: "Bottom", binStart: 0, binEnd: 1, count: 1 },
          { category: "A", facetX: "R", facetY: "Bottom", binStart: 0, binEnd: 1, count: 1 },
        ],
      },
    ]),
    dictionaries: {
      x: ["A"],
      facetX: ["L", "R"],
      facetY: ["Top", "Bottom"],
    },
    rawChunks: [
      {
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 4,
        xValues: new Uint32Array([0, 0, 0, 0]),
        yValues: new Float64Array([1, 2, 3, 4]),
        rowIds: new BigInt64Array([1n, 2n, 3n, 4n]),
        facetXCodes: new Uint32Array([0, 1, 0, 1]),
        facetYCodes: new Uint32Array([0, 0, 1, 1]),
        validity: {
          x: new Uint8Array([0b00001111]),
          y: new Uint8Array([0b00001111]),
          facetX: new Uint8Array([0b00001111]),
          facetY: new Uint8Array([0b00001111]),
        },
      },
    ],
  };

  const spec: GraphSpec = {
    encoding: {
      x: { name: "cat", type: "nominal" },
      y: { name: "v", type: "continuous" },
      groupX: { name: "fx", type: "nominal" },
      groupY: { name: "fy", type: "nominal" },
    },
    elements: [
      { kind: "histogram", enabled: true, options: { histStyle: "bar" } },
      { kind: "points", enabled: true, options: { summaryStat: "none" } },
    ],
  };

  const built = buildGraph(spec, data, theme, undefined, frame);
  assert.equal(built.cols, 2);
  assert.equal(built.rows, 2);
  for (const panel of built.panels) {
    assert.ok(panel.rawPoints, "frame-backed faceted panel should expose a panel-local raw descriptor");
    const drawn = drawRawPoints(panel.rawPoints!, {
      plotRect: { x: 0, y: 0, width: 64, height: 64 },
      x: { kind: "categorical", pixelsByCategory: new Float64Array([10]) },
      y: { kind: "numeric", scale: -1, offset: 32 },
    });
    assert.equal(drawn.points.length, 1, "each facet panel should keep only its local typed rows via facet mask");
    const series = panelSeries(panel.option as Record<string, unknown>);
    assert.ok(series.length > 0, "facet panel should render packet-backed series");
  }
}
