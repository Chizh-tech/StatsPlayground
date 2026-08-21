import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  bigintToSafeNumber,
  bigintToScatterPointPick,
  buildPixelIndex,
  computeCanvasBackingStore,
  drawRawPoints,
  hitTestBrush,
  hitTestPoint,
  resetAndScaleCanvasContext,
  rasterizeToRgba,
  stableRgbaDigest,
  type RawPointChunkViews,
  type RawPointPanelDescriptor,
  type RawPointProjector,
} from "../src/graphCore/rawPoints.ts";
import {
  applyZrenderCanvasZIndices,
  GRAPH_RAW_CANVAS_Z_INDEX,
  GRAPH_SERIES_BASE_ZLEVEL,
  GRAPH_SERIES_OVERLAY_ZLEVEL,
  withInterleavedGraphLayers,
} from "../src/graphCore/layers.ts";

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));

{
  const perfHarnessSource = readFileSync(
    resolve(TEST_FILE_DIR, "../src-tauri/src/perf_harness.rs"),
    "utf8",
  );
  assert.equal(
    perfHarnessSource.includes("decode_ms: Some(DesktopOnlyMetric::DesktopOnly)"),
    true,
    "perf harness graph report must keep decodeMs as desktop_only in Node benchmarks",
  );
  assert.equal(
    perfHarnessSource.includes("draw_ms: Some(DesktopOnlyMetric::DesktopOnly)"),
    true,
    "perf harness graph report must keep drawMs as desktop_only in Node benchmarks",
  );
}

function bitsFromFlags(flags: number[]): Uint8Array {
  const bytes = new Uint8Array(Math.max(1, Math.ceil(flags.length / 8)));
  for (let i = 0; i < flags.length; i += 1) {
    if (flags[i]) bytes[i >> 3] |= 1 << (i & 7);
  }
  return bytes;
}

function makeChunk(
  xValues: Float64Array | Uint32Array,
  yValues: Float64Array,
  rowIds: BigInt64Array,
  xValidityFlags: number[],
  yValidityFlags: number[],
  facetFlags?: number[],
): RawPointChunkViews {
  return {
    xValues,
    yValues,
    rowIds,
    xValidity: bitsFromFlags(xValidityFlags),
    yValidity: bitsFromFlags(yValidityFlags),
    facetMask: facetFlags ? bitsFromFlags(facetFlags) : undefined,
  };
}

const numericProjector: RawPointProjector = {
  plotRect: { x: 0, y: 0, width: 64, height: 64 },
  x: { kind: "numeric", scale: 2, offset: 1 },
  y: { scale: -2, offset: 62 },
};

{
  assert.equal(bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER)), Number.MAX_SAFE_INTEGER);
  assert.equal(bigintToSafeNumber(BigInt(Number.MIN_SAFE_INTEGER)), Number.MIN_SAFE_INTEGER);
  assert.equal(bigintToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n), null);
  assert.equal(bigintToSafeNumber(BigInt(Number.MIN_SAFE_INTEGER) - 1n), null);

  assert.deepEqual(bigintToScatterPointPick(42n, "metric"), { rowId: 42, colName: "metric" });
  assert.equal(bigintToScatterPointPick(-1n, "metric"), null);
  assert.equal(bigintToScatterPointPick(BigInt(Number.MAX_SAFE_INTEGER) + 1n, "metric"), null);
}

{
  const dpr1 = computeCanvasBackingStore(640, 480, 1);
  assert.deepEqual(dpr1, {
    cssWidth: 640,
    cssHeight: 480,
    pixelWidth: 640,
    pixelHeight: 480,
    scale: 1,
  });

  const dpr2 = computeCanvasBackingStore(640, 480, 2);
  assert.deepEqual(dpr2, {
    cssWidth: 640,
    cssHeight: 480,
    pixelWidth: 1280,
    pixelHeight: 960,
    scale: 2,
  });

  const calls: string[] = [];
  const ctx = {
    setTransform(a: number, _b: number, _c: number, d: number) {
      calls.push(`setTransform:${a},${d}`);
    },
    clearRect(_x: number, _y: number, w: number, h: number) {
      calls.push(`clearRect:${w}x${h}`);
    },
  };
  resetAndScaleCanvasContext(ctx, dpr2);
  assert.deepEqual(calls, [
    "setTransform:1,1",
    "clearRect:1280x960",
    "setTransform:2,2",
  ]);
}

{
  const layered = withInterleavedGraphLayers({
    series: [
      { id: "bars", type: "bar" },
      { id: "labels-top", type: "scatter", label: { show: true } },
      { id: "labels-emphasis", type: "bar", emphasis: { label: { show: true } } },
      { id: "__ref_lines_y__", type: "line" },
      { id: "markline-carrier", type: "line", markLine: { data: [] } },
      { id: "fit__fitstats", type: "scatter" },
      { id: "upper-custom", type: "custom", zlevel: 20 },
    ],
  }) as { series: Array<{ id: string; zlevel: number }> };

  assert.equal(layered.series[0].zlevel, GRAPH_SERIES_BASE_ZLEVEL);
  assert.equal(layered.series[1].zlevel, GRAPH_SERIES_OVERLAY_ZLEVEL);
  assert.equal(layered.series[2].zlevel, GRAPH_SERIES_BASE_ZLEVEL);
  assert.equal(layered.series[3].zlevel, GRAPH_SERIES_OVERLAY_ZLEVEL);
  assert.equal(layered.series[4].zlevel, GRAPH_SERIES_OVERLAY_ZLEVEL);
  assert.equal(layered.series[5].zlevel, GRAPH_SERIES_OVERLAY_ZLEVEL);
  assert.equal(layered.series[6].zlevel, 20);
  assert.ok(
    GRAPH_SERIES_BASE_ZLEVEL < GRAPH_RAW_CANVAS_Z_INDEX &&
      GRAPH_RAW_CANVAS_Z_INDEX < GRAPH_SERIES_OVERLAY_ZLEVEL,
  );

  const layers = {
    "10": { dom: { style: {} } },
    "0": { dom: { style: {} } },
    "bad": { dom: { style: {} } },
  } as Record<string, { dom: { style: { zIndex?: string } } }>;
  const applied = applyZrenderCanvasZIndices(layers);
  assert.equal(applied, 2);
  assert.equal(layers["0"].dom.style.zIndex, "0");
  assert.equal(layers["10"].dom.style.zIndex, "10");
}

{
  const descriptor: RawPointPanelDescriptor = {
    colName: "y",
    jitter: { mode: "none" },
    chunks: [
      makeChunk(
        new Float64Array([2, 2, 6, 8, 10]),
        new Float64Array([4, 4, 10, 11, 12]),
        new BigInt64Array([101n, 102n, 103n, 104n, 105n]),
        [1, 1, 1, 1, 0],
        [1, 1, 1, 0, 1],
        [1, 1, 1, 1, 1],
      ),
    ],
  };

  const drawn = drawRawPoints(descriptor, numericProjector);
  assert.equal(drawn.totalRows, 5);
  assert.equal(drawn.drawnRows, 3);
  assert.equal(drawn.points.length, 3);
  assert.deepEqual(
    drawn.points.map((point) => [point.px, point.py, Number(point.rowId)]),
    [
      [5, 54, 101],
      [5, 54, 102],
      [13, 42, 103],
    ],
  );

  const index = buildPixelIndex(64, 64, drawn.points);
  const hit = hitTestPoint(index, 5, 54);
  assert.ok(hit);
  assert.deepEqual(hit?.topmost, { rowId: 102n, colName: "y" });
  assert.deepEqual(hit?.overlaps, [
    { rowId: 101n, colName: "y" },
    { rowId: 102n, colName: "y" },
  ]);

  const brush = hitTestBrush(index, { x1: 0, y1: 40, x2: 20, y2: 60 });
  assert.deepEqual(brush, [
    { rowId: 101n, colName: "y" },
    { rowId: 102n, colName: "y" },
    { rowId: 103n, colName: "y" },
  ]);
}

{
  const descriptor: RawPointPanelDescriptor = {
    colName: "metric",
    jitter: { mode: "none" },
    xCategories: ["A", "B", "C"],
    chunks: [
      makeChunk(
        new Uint32Array([0, 1, 2, 1]),
        new Float64Array([2, 4, 6, 8]),
        new BigInt64Array([201n, 202n, 203n, 204n]),
        [1, 1, 1, 1],
        [1, 1, 1, 1],
        [1, 0, 1, 1],
      ),
    ],
  };

  const projector: RawPointProjector = {
    plotRect: { x: 0, y: 0, width: 64, height: 64 },
    x: {
      kind: "categorical",
      pixelsByCategory: new Float64Array([10, 30, 50]),
    },
    y: { scale: -4, offset: 60 },
  };
  const drawn = drawRawPoints(descriptor, projector);
  assert.deepEqual(
    drawn.points.map((point) => [point.px, point.py, Number(point.rowId)]),
    [
      [10, 52, 201],
      [50, 36, 203],
      [30, 28, 204],
    ],
  );
}

{
  const descriptor: RawPointPanelDescriptor = {
    colName: "digestCol",
    jitter: { mode: "seeded", seed: 42, amplitudePx: 2 },
    chunks: [
      makeChunk(
        new Float64Array([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]),
        new Float64Array([3, 4, 5, 6, 7, 8, 9, 10, 11, 12]),
        new BigInt64Array([1n, 2n, 3n, 4n, 5n, 6n, 7n, 8n, 9n, 10n]),
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
        [1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
      ),
    ],
  };
  const rgbaA = rasterizeToRgba(64, 64, descriptor, numericProjector);
  const rgbaB = rasterizeToRgba(64, 64, descriptor, numericProjector);
  assert.deepEqual(rgbaA, rgbaB);
  assert.equal(stableRgbaDigest(rgbaA), "1a49a1b6852baea5");
}
