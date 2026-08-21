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
  const data = baseData(["x", "y"], []);
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
    },
    elements: [{ kind: "heatmap" as any, enabled: true }],
  };

  const frame = baseFrame([
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
  ]);

  const built = buildGraph(spec, data, theme, undefined, frame);
  const series = panelSeries(built.panels[0].option as Record<string, unknown>);
  const heatSeries = series.find((entry) => entry.type === "heatmap" || entry.type === "custom");
  assert.ok(heatSeries, "heatmap packet should produce a renderable series");
  const points = Array.isArray(heatSeries?.data) ? (heatSeries?.data as unknown[][]) : [];
  assert.ok(
    points.some((row) => Number(row[0]) === 0.5 && Number(row[1]) === 0.5 && Number(row[2]) === 2),
    "heatmap packet cell center/count must map to heatmap series data",
  );
}

{
  const data = baseData(
    ["x", "y"],
    [["A", 1], ["A", 2], ["A", 3], ["B", 100]],
  );
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "nominal" },
      y: { name: "y", type: "continuous" },
    },
    elements: [{ kind: "boxplot", enabled: true }],
  };

  const built = buildGraph(spec, data, theme, undefined, baseFrame([]));
  const series = panelSeries(built.panels[0].option as Record<string, unknown>);
  assert.equal(series.some((entry) => entry.type === "boxplot"), false, "frame-backed boxplot must not fall back to row scan when packet is missing");
}

{
  const data = baseData(
    ["x", "y"],
    [["A", 1], ["A", 2], ["B", 10], ["B", 11]],
  );
  const spec: GraphSpec = {
    encoding: {
      x: { name: "x", type: "nominal" },
      y: { name: "y", type: "continuous" },
    },
    elements: [{ kind: "points", enabled: true, options: { summaryStat: "mean" } }],
  };

  const built = buildGraph(spec, data, theme, undefined, baseFrame([]));
  const series = panelSeries(built.panels[0].option as Record<string, unknown>);
  assert.equal(
    series.some((entry) => String(entry.id ?? "").endsWith("__summary")),
    false,
    "frame-backed summary points must not be derived from row scan when summary packet is missing",
  );
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
