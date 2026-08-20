import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decodeGraphPayload, isGraphAggregatePacket } from "../src/types/graphData.ts";
import {
  createInitialGraphStreamState,
  deriveFields,
  reduceGraphStream,
  type GraphStreamState,
} from "../src/components/graphBuilder/useGraphDataPipeline.ts";
import { createGraphStreamTransport } from "../src/services/graphDataTransport.ts";
import type {
  GraphChunkHeader,
  GraphDataCompletion,
  GraphDataRequest,
  GraphDataFrame,
} from "../src/types/graphData.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";

const TEST_FILE_DIR = dirname(fileURLToPath(import.meta.url));

export function makeGraphRows(count: number): Array<[number, string, number]> {
  return Array.from({ length: count }, (_, index) => [
    index + 1,
    ["Central", "East", "North", "South", "West"][index % 5],
    (index * 37) % 7200,
  ]);
}

assert.equal(makeGraphRows(10).length, 10);

{
  const graphSource = readFileSync(resolve(TEST_FILE_DIR, "../src/graphCore/Graph.tsx"), "utf8");
  assert.equal(graphSource.includes("toScatterPick("), false, "Graph.tsx must not call undefined toScatterPick");
  const helperUses = graphSource.match(/bigintToScatterPointPick\(/g) ?? [];
  assert.ok(helperUses.length >= 2, "Graph.tsx click and brush conversion must share bigintToScatterPointPick helper");
}

{
  const graphBuilderViewSource = readFileSync(
    resolve(TEST_FILE_DIR, "../src/components/graphBuilder/GraphBuilderView.tsx"),
    "utf8",
  );
  assert.equal(
    graphBuilderViewSource.includes("dataService.queryTable("),
    false,
    "GraphBuilderView production graph path must not query full table via dataService.queryTable",
  );
  assert.equal(
    graphBuilderViewSource.includes("applyFilters(data"),
    false,
    "GraphBuilderView production graph path must not use frontend applyFilters(data, ...)",
  );
  assert.equal(
    graphBuilderViewSource.includes("newRows.push([...row"),
    false,
    "GraphBuilderView production graph path must not do frontend melt expansion with newRows.push([...row, ...])",
  );
}

const payload = new ArrayBuffer(80);
new Float64Array(payload, 0, 2).set([1.5, 2.5]);
new Float64Array(payload, 16, 2).set([10.25, 20.5]);
new BigInt64Array(payload, 32, 2).set([101n, 102n]);
new Uint32Array(payload, 48, 2).set([0, 1]);
new Uint8Array(payload, 56, 2).set([1, 0]);
new Uint8Array(payload, 64, 2).set([1, 1]);

const decoded = decodeGraphPayload(
  {
    requestId: "req-1",
    generation: 7,
    chunkIndex: 0,
    rowOffset: 0,
    rowCount: 2,
    sourceRows: 2,
    processedRows: 2,
    dictionaries: {
      x: ["Central", "East"],
    },
    validityRanges: {
      x: { type: "u8", offset: 56, byteLength: 2 },
      y: { type: "u8", offset: 64, byteLength: 2 },
    },
    xValues: { type: "u32", offset: 48, byteLength: 8 },
    yValues: { type: "f64", offset: 16, byteLength: 16 },
    rowIds: { type: "i64", offset: 32, byteLength: 16 },
    groupCodes: undefined,
    sizeValues: { type: "f64", offset: 0, byteLength: 16 },
    xEncoding: "categorical",
    finalChunk: true,
  },
  payload,
);

assert.deepEqual(Array.from(decoded.xValues), [0, 1]);
assert.deepEqual(Array.from(decoded.yValues), [10.25, 20.5]);
assert.deepEqual(Array.from(decoded.rowIds), [101n, 102n]);
assert.deepEqual(Array.from(decoded.sizeValues ?? []), [1.5, 2.5]);
assert.deepEqual(decoded.dictionaries.x, ["Central", "East"]);
assert.deepEqual(Array.from(decoded.validity.x), [1, 0]);
assert.deepEqual(Array.from(decoded.validity.y), [1, 1]);

const dynamicPayload = new ArrayBuffer(184);
new Uint32Array(dynamicPayload, 0, 2).set([0, 1]);
new Float64Array(dynamicPayload, 8, 2).set([10, 20]);
new BigInt64Array(dynamicPayload, 24, 2).set([901n, 902n]);
new Float64Array(dynamicPayload, 40, 2).set([100, 200]);
new Uint32Array(dynamicPayload, 56, 2).set([1, 0]);
new Uint32Array(dynamicPayload, 64, 2).set([0, 1]);
new Uint32Array(dynamicPayload, 72, 2).set([1, 0]);
new Uint32Array(dynamicPayload, 80, 2).set([0, 1]);
new Uint32Array(dynamicPayload, 88, 2).set([1, 1]);
new Uint32Array(dynamicPayload, 96, 2).set([1, 0]);
new Uint8Array(dynamicPayload, 104, 2).set([1, 1]);
new Uint8Array(dynamicPayload, 112, 2).set([1, 1]);
new Uint8Array(dynamicPayload, 120, 2).set([1, 1]);
new Uint8Array(dynamicPayload, 128, 2).set([1, 1]);
new Uint8Array(dynamicPayload, 136, 2).set([1, 1]);
new Uint8Array(dynamicPayload, 144, 2).set([1, 1]);
new Uint8Array(dynamicPayload, 152, 2).set([1, 1]);
new Uint8Array(dynamicPayload, 160, 2).set([1, 1]);
new Uint8Array(dynamicPayload, 168, 2).set([1, 1]);

const dynamicDecoded = decodeGraphPayload(
  {
    requestId: "req-dynamic",
    generation: 8,
    chunkIndex: 0,
    rowOffset: 0,
    rowCount: 2,
    sourceRows: 2,
    processedRows: 2,
    dictionaries: {
      x: ["A", "B"],
      source: ["m1", "m2"],
      group: ["G0", "G1"],
      facetX: ["L", "R"],
      facetY: ["Top", "Bottom"],
      facetZ: ["Front", "Back"],
      wrap: ["W1", "W2"],
    },
    validityRanges: {
      x: { type: "u8", offset: 104, byteLength: 2 },
      y: { type: "u8", offset: 112, byteLength: 2 },
      z: { type: "u8", offset: 120, byteLength: 2 },
      source: { type: "u8", offset: 128, byteLength: 2 },
      group: { type: "u8", offset: 136, byteLength: 2 },
      facetX: { type: "u8", offset: 144, byteLength: 2 },
      facetY: { type: "u8", offset: 152, byteLength: 2 },
      facetZ: { type: "u8", offset: 160, byteLength: 2 },
      wrap: { type: "u8", offset: 168, byteLength: 2 },
    },
    xValues: { type: "u32", offset: 0, byteLength: 8 },
    yValues: { type: "f64", offset: 8, byteLength: 16 },
    rowIds: { type: "i64", offset: 24, byteLength: 16 },
    zValues: { type: "f64", offset: 40, byteLength: 16 },
    roleVectors: {
      source: { type: "u32", offset: 56, byteLength: 8 },
      group: { type: "u32", offset: 64, byteLength: 8 },
      groupX: { type: "u32", offset: 72, byteLength: 8 },
      groupY: { type: "u32", offset: 80, byteLength: 8 },
      groupZ: { type: "u32", offset: 96, byteLength: 8 },
      wrap: { type: "u32", offset: 88, byteLength: 8 },
    },
    xEncoding: "categorical",
    finalChunk: true,
  } as GraphChunkHeader,
  dynamicPayload,
);

assert.deepEqual(Array.from(dynamicDecoded.sourceCodes ?? []), [1, 0]);
assert.deepEqual(Array.from(dynamicDecoded.groupCodes ?? []), [0, 1]);
assert.deepEqual(Array.from(dynamicDecoded.facetXCodes ?? []), [1, 0]);
assert.deepEqual(Array.from(dynamicDecoded.facetYCodes ?? []), [0, 1]);
assert.deepEqual(Array.from(dynamicDecoded.facetZCodes ?? []), [1, 0]);
assert.deepEqual(Array.from(dynamicDecoded.wrapCodes ?? []), [1, 1]);
assert.deepEqual(Array.from(dynamicDecoded.rowIds), [901n, 902n]);

assert.equal(isGraphAggregatePacket({ kind: "histogram" }), false);
assert.equal(isGraphAggregatePacket({ kind: "histogram", payload: {} }), false);
assert.equal(isGraphAggregatePacket({
  kind: "histogram",
  yColumn: "cost",
  binCount: 20,
  missingCount: 0,
  binWidth: 1,
  totalCount: 2,
  bins: [],
}), true);

assert.equal(isGraphAggregatePacket({
  kind: "histogram",
  yColumn: "cost",
  binCount: 20,
  missingCount: 0,
  binWidth: 1,
  totalCount: 1,
  bins: [
    {
      group: "G1",
      category: "A",
      sourceColumn: "m1",
      facetX: "L",
      facetY: "Top",
      facetZ: undefined,
      wrap: "W1",
      binStart: 0,
      binEnd: 1,
      count: 1,
    },
  ],
}), true);

assert.equal(isGraphAggregatePacket({
  kind: "histogram",
  yColumn: "cost",
  binCount: 20,
  missingCount: 0,
  binWidth: 1,
  totalCount: 1,
  bins: [
    {
      group: "G1",
      category: "A",
      sourceColumn: "m1",
      facetX: "L",
      binStart: 0,
      binEnd: 1,
      count: 1,
    },
  ],
}), false);

assert.throws(
  () =>
    decodeGraphPayload(
      {
        requestId: "req-required-mismatch",
        generation: 7,
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 2,
        sourceRows: 2,
        processedRows: 2,
        dictionaries: {},
        validityRanges: {
          x: { type: "u8", offset: 56, byteLength: 2 },
        },
        xValues: { type: "u32", offset: 48, byteLength: 8 },
        yValues: { type: "f64", offset: 16, byteLength: 8 },
        rowIds: { type: "i64", offset: 32, byteLength: 16 },
        xEncoding: "categorical",
        finalChunk: false,
      },
      payload,
    ),
  /rowCount/i,
);

assert.throws(
  () =>
    decodeGraphPayload(
      {
        requestId: "req-optional-mismatch",
        generation: 7,
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 2,
        sourceRows: 2,
        processedRows: 2,
        dictionaries: {},
        validityRanges: {
          x: { type: "u8", offset: 56, byteLength: 2 },
        },
        xValues: { type: "u32", offset: 48, byteLength: 8 },
        yValues: { type: "f64", offset: 16, byteLength: 16 },
        rowIds: { type: "i64", offset: 32, byteLength: 16 },
        groupCodes: { type: "u32", offset: 72, byteLength: 4 },
        xEncoding: "categorical",
        finalChunk: false,
      },
      payload,
    ),
  /rowCount/i,
);

assert.throws(
  () =>
    decodeGraphPayload(
      {
        requestId: "req-validity-mismatch",
        generation: 7,
        chunkIndex: 0,
        rowOffset: 0,
        rowCount: 9,
        sourceRows: 9,
        processedRows: 9,
        dictionaries: {},
        validityRanges: {
          x: { type: "u8", offset: 184, byteLength: 1 },
        },
        xValues: { type: "u32", offset: 0, byteLength: 36 },
        yValues: { type: "f64", offset: 40, byteLength: 72 },
        rowIds: { type: "i64", offset: 112, byteLength: 72 },
        xEncoding: "categorical",
        finalChunk: false,
      },
      new ArrayBuffer(256),
    ),
  /validity/i,
);

function makeRequest(requestId: string, generation: number): GraphDataRequest {
  return {
    requestId,
    datasetId: "dataset-1",
    generation,
    fields: [
      { role: "x", column: "region" },
      { role: "y", column: "cost" },
    ],
    filters: [],
    elements: [{ kind: "points", summaryStat: "none" }],
    sampling: { mode: "full" },
    viewport: { width: 1280, height: 720 },
  };
}

function makeHeader(
  requestId: string,
  generation: number,
  chunkIndex: number,
  finalChunk: boolean,
): GraphChunkHeader {
  return {
    requestId,
    generation,
    chunkIndex,
    rowOffset: chunkIndex * 2,
    rowCount: 2,
    sourceRows: 4,
    processedRows: (chunkIndex + 1) * 2,
    dictionaries: { x: ["Central", "East"] },
    validityRanges: {
      x: { type: "u8", offset: 56, byteLength: 2 },
      y: { type: "u8", offset: 64, byteLength: 2 },
    },
    xValues: { type: "u32", offset: 48, byteLength: 8 },
    yValues: { type: "f64", offset: 16, byteLength: 16 },
    rowIds: { type: "i64", offset: 32, byteLength: 16 },
    sizeValues: { type: "f64", offset: 0, byteLength: 16 },
    xEncoding: "categorical",
    finalChunk,
  };
}

function makePayload(seed: number): ArrayBuffer {
  const out = new ArrayBuffer(80);
  new Float64Array(out, 0, 2).set([1.5 + seed, 2.5 + seed]);
  new Float64Array(out, 16, 2).set([10.25 + seed, 20.5 + seed]);
  new BigInt64Array(out, 32, 2).set([BigInt(101 + seed), BigInt(102 + seed)]);
  new Uint32Array(out, 48, 2).set([0, 1]);
  new Uint8Array(out, 56, 2).set([1, 1]);
  new Uint8Array(out, 64, 2).set([1, 1]);
  return out;
}

function makeCompletion(requestId: string, generation: number, cancelled = false): GraphDataCompletion {
  return {
    requestId,
    datasetId: "dataset-1",
    generation,
    sourceRows: 4,
    processedRows: 4,
    chunksSent: 2,
    cancelled,
  };
}

function makeCommittedFrame(): GraphDataFrame {
  return {
    requestId: "old-request",
    datasetId: "dataset-1",
    generation: 1,
    sourceRows: 2,
    processedRows: 2,
    sampling: { mode: "full" },
    dictionaries: {},
    extents: {},
    rawChunks: [],
    aggregates: [],
  };
}

const histogramPacket = {
  kind: "histogram" as const,
  yColumn: "cost",
  binCount: 20,
  missingCount: 0,
  binWidth: 1,
  totalCount: 2,
  bins: [],
};

function run(state: GraphStreamState, ...messages: Parameters<typeof reduceGraphStream>[1][]): GraphStreamState {
  let next = state;
  for (const message of messages) {
    next = reduceGraphStream(next, message);
  }
  return next;
}

function makeGraphBuilderItem(overrides: Partial<GraphBuilderItem> = {}): GraphBuilderItem {
  return {
    id: "graph-1",
    name: "Graph 1",
    sourceDatasetId: "dataset-1",
    encoding: {
      x: { name: "region", type: "nominal" },
      y: { name: "cost", type: "continuous" },
    },
    elements: [{ kind: "points", enabled: true }],
    smootherLambda: 0.5,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function roleColumns(fields: ReturnType<typeof deriveFields>, role: string): string[] {
  return fields.filter((field) => field.role === role).map((field) => field.column);
}

{
  const initial = createInitialGraphStreamState(makeCommittedFrame());
  const request = makeRequest("req-atomic", 7);
  const afterChunks = run(
    initial,
    { type: "start", request },
    { type: "aggregate", packet: histogramPacket },
    { type: "header", header: makeHeader("req-atomic", 7, 0, false) },
    { type: "payload", payload: makePayload(0) },
    { type: "header", header: makeHeader("req-atomic", 7, 1, true) },
    { type: "payload", payload: makePayload(10) },
  );

  assert.equal(afterChunks.committed?.requestId, "old-request");
  assert.equal(afterChunks.pending?.chunks.length, 2);

  const committed = reduceGraphStream(afterChunks, {
    type: "complete",
    completion: makeCompletion("req-atomic", 7),
  });

  assert.equal(committed.pending, null);
  assert.equal(committed.committed?.requestId, "req-atomic");
  assert.equal(committed.committed?.rawChunks.length, 2);
  assert.equal(committed.committed?.aggregates.length, 1);
  assert.equal(committed.error, null);
}

{
  const request = makeRequest("req-terminal-before-payload", 13);
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request },
    { type: "header", header: makeHeader("req-terminal-before-payload", 13, 0, false) },
    { type: "payload", payload: makePayload(0) },
    { type: "header", header: makeHeader("req-terminal-before-payload", 13, 1, true) },
    { type: "complete", completion: makeCompletion("req-terminal-before-payload", 13) },
  );

  assert.equal(state.pending, null);
  assert.equal(state.committed?.requestId, "old-request");
  assert.match(state.error ?? "", /pending header/i);
}

{
  const request = makeRequest("req-stale", 3);
  const state = run(
    createInitialGraphStreamState(),
    { type: "start", request },
    { type: "header", header: makeHeader("req-stale", 2, 0, false) },
    { type: "header", header: makeHeader("other-request", 3, 0, false) },
  );

  assert.equal(state.pending?.chunks.length, 0);
  assert.equal(state.pendingHeader, null);
}

{
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-dup", 9) },
    { type: "header", header: makeHeader("req-dup", 9, 0, false) },
    { type: "payload", payload: makePayload(0) },
    { type: "header", header: makeHeader("req-dup", 9, 0, true) },
  );

  assert.equal(state.pending, null);
  assert.equal(state.committed?.requestId, "old-request");
  assert.match(state.error ?? "", /out of order/i);
}

{
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-out-of-order", 17) },
    { type: "header", header: makeHeader("req-out-of-order", 17, 1, false) },
  );

  assert.equal(state.pending, null);
  assert.equal(state.committed?.requestId, "old-request");
  assert.match(state.error ?? "", /out of order/i);
}

{
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-order", 4) },
    { type: "payload", payload: makePayload(0) },
  );

  assert.equal(state.pending, null);
  assert.equal(state.committed?.requestId, "old-request");
  assert.match(state.error ?? "", /payload/i);
}

{
  const start = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-cancel", 10) },
    { type: "header", header: makeHeader("req-cancel", 10, 0, false) },
  );
  const cancelled = reduceGraphStream(start, {
    type: "complete",
    completion: makeCompletion("req-cancel", 10, true),
  });

  assert.equal(cancelled.pending, null);
  assert.equal(cancelled.committed?.requestId, "old-request");
}

{
  const mismatch = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-terminal-mismatch", 12) },
    { type: "header", header: makeHeader("req-terminal-mismatch", 12, 0, true) },
    { type: "payload", payload: makePayload(0) },
    {
      type: "complete",
      completion: {
        ...makeCompletion("req-terminal-mismatch", 12),
        chunksSent: 2,
      },
    },
  );

  assert.equal(mismatch.pending, null);
  assert.equal(mismatch.committed?.requestId, "old-request");
  assert.match(mismatch.error ?? "", /inconsistent/i);
}

{
  const state = run(
    createInitialGraphStreamState(makeCommittedFrame()),
    { type: "start", request: makeRequest("req-error", 11) },
    { type: "error", requestId: "req-stale", generation: 10, error: "stale" },
  );

  assert.equal(state.pending?.request.requestId, "req-error");

  const errored = reduceGraphStream(state, {
    type: "error",
    requestId: "req-error",
    generation: 11,
    error: "boom",
  });
  assert.equal(errored.pending, null);
  assert.equal(errored.committed?.requestId, "old-request");
  assert.equal(errored.error, "boom");
}

{
  const events: string[] = [];
  let transportError: string | null = null;
  let completionCalls = 0;
  const request = makeRequest("req-transport-order", 22);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {
      events.push("header");
    },
    onPayload: () => {
      events.push("payload");
    },
    onComplete: () => {
      events.push("complete");
      completionCalls += 1;
    },
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onChannelMessage({
    messageType: "header",
    ...makeHeader("req-transport-order", 22, 0, true),
  });
  transport.onChannelMessage(makePayload(0));
  transport.onChannelMessage({
    messageType: "complete",
    ...makeCompletion("req-transport-order", 22),
    chunksSent: 1,
  });

  assert.equal(transportError, null);
  assert.deepEqual(events, ["header", "payload", "complete"]);
  assert.equal(completionCalls, 1);
}

{
  let completed = false;
  let transportError: string | null = null;
  const request = makeRequest("req-invoke-before-terminal", 23);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {},
    onPayload: () => {},
    onComplete: () => {
      completed = true;
    },
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onInvokeResolved({
    ...makeCompletion("req-invoke-before-terminal", 23),
    chunksSent: 1,
  });
  assert.equal(completed, false);

  transport.onChannelMessage({
    messageType: "header",
    ...makeHeader("req-invoke-before-terminal", 23, 0, true),
  });
  transport.onChannelMessage(makePayload(0));
  transport.onChannelMessage({
    messageType: "complete",
    ...makeCompletion("req-invoke-before-terminal", 23),
    chunksSent: 1,
  });

  assert.equal(transportError, null);
  assert.equal(completed, true);
}

{
  let completed = false;
  let transportError: string | null = null;
  const request = makeRequest("req-terminal-incomplete", 24);
  const transport = createGraphStreamTransport(request, {
    onHeader: () => {},
    onPayload: () => {},
    onComplete: () => {
      completed = true;
    },
    onError: (message) => {
      transportError = message;
    },
  });

  transport.onChannelMessage({
    messageType: "header",
    ...makeHeader("req-terminal-incomplete", 24, 0, true),
  });
  transport.onChannelMessage(makePayload(0));
  transport.onChannelMessage({
    messageType: "complete",
    ...makeCompletion("req-terminal-incomplete", 24),
    chunksSent: 2,
  });

  assert.equal(completed, false);
  assert.match(transportError ?? "", /inconsistent chunksSent/i);
}

{
  const colorGrouped = makeGraphBuilderItem({
    encoding: {
      x: { name: "x", type: "continuous" },
      y: { name: "y", type: "continuous" },
      color: { name: "segment", type: "nominal" },
    },
    hiddenGroups: ["A"],
  });
  const fields = deriveFields(colorGrouped);
  assert.deepEqual(roleColumns(fields, "group"), ["segment"]);
  assert.deepEqual(roleColumns(fields, "x"), ["x"]);
  assert.deepEqual(roleColumns(fields, "y"), ["y"]);

  const overlayFallback = deriveFields(
    makeGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        overlay: { name: "ov", type: "nominal" },
        color: { name: "segment", type: "nominal" },
      },
      hiddenGroups: ["A"],
    }),
  );
  assert.deepEqual(roleColumns(overlayFallback, "group"), ["ov"]);

  const groupXFallback = deriveFields(
    makeGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        groupX: { name: "gx", type: "nominal" },
      },
      hiddenGroups: ["A"],
    }),
  );
  assert.deepEqual(roleColumns(groupXFallback, "group"), ["gx"]);
  assert.deepEqual(roleColumns(groupXFallback, "groupX"), ["gx"]);

  const groupYFallback = deriveFields(
    makeGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        groupY: { name: "gy", type: "nominal" },
      },
      hiddenGroups: ["A"],
    }),
  );
  assert.deepEqual(roleColumns(groupYFallback, "group"), ["gy"]);
  assert.deepEqual(roleColumns(groupYFallback, "groupY"), ["gy"]);

  const groupZFallback = deriveFields(
    makeGraphBuilderItem({
      threeD: true,
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        z: { name: "z", type: "continuous" },
        groupZ: { name: "gz", type: "nominal" },
      },
      hiddenGroups: ["A"],
      elements: [{ kind: "scatter3d", enabled: true }],
    }),
  );
  assert.deepEqual(roleColumns(groupZFallback, "group"), ["gz"]);
  assert.deepEqual(roleColumns(groupZFallback, "groupZ"), ["gz"]);
}

{
  const activeMultiX = deriveFields(
    makeGraphBuilderItem({
      encoding: {
        x: { name: "x_stale", type: "continuous" },
        y: { name: "y", type: "continuous" },
      },
      multiX: [
        { name: "mx0", type: "continuous" },
        { name: "mx1", type: "continuous" },
        { name: "mx2", type: "continuous" },
      ],
    }),
  );

  assert.deepEqual(roleColumns(activeMultiX, "x"), ["x_stale"]);
  assert.deepEqual(roleColumns(activeMultiX, "multiX0"), ["mx0"]);
  assert.deepEqual(roleColumns(activeMultiX, "multiX1"), ["mx1"]);
  assert.deepEqual(roleColumns(activeMultiX, "multiX2"), ["mx2"]);

  const activeMultiY = deriveFields(
    makeGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y_stale", type: "continuous" },
      },
      multiY: [
        { name: "my0", type: "continuous" },
        { name: "my1", type: "continuous" },
      ],
    }),
  );

  assert.deepEqual(roleColumns(activeMultiY, "y"), ["y_stale"]);
  assert.deepEqual(roleColumns(activeMultiY, "multiY0"), ["my0"]);
  assert.deepEqual(roleColumns(activeMultiY, "multiY1"), ["my1"]);

  const activeMultiBoth = deriveFields(
    makeGraphBuilderItem({
      encoding: {
        x: { name: "x_stale", type: "continuous" },
        y: { name: "y_stale", type: "continuous" },
      },
      multiX: [
        { name: "mx0", type: "continuous" },
        { name: "mx1", type: "continuous" },
      ],
      multiY: [
        { name: "my0", type: "continuous" },
        { name: "my1", type: "continuous" },
        { name: "my2", type: "continuous" },
      ],
    }),
  );

  assert.deepEqual(roleColumns(activeMultiBoth, "multiX0"), ["mx0"]);
  assert.deepEqual(roleColumns(activeMultiBoth, "multiX1"), ["mx1"]);
  assert.deepEqual(roleColumns(activeMultiBoth, "multiY0"), ["my0"]);
  assert.deepEqual(roleColumns(activeMultiBoth, "multiY1"), ["my1"]);
  assert.deepEqual(roleColumns(activeMultiBoth, "multiY2"), ["my2"]);

  const staleInactiveMulti = deriveFields(
    makeGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
      },
      multiX: [{ name: "only_one", type: "continuous" }],
      multiY: [{ name: "also_one", type: "continuous" }],
    }),
  );

  assert.deepEqual(roleColumns(staleInactiveMulti, "multiX0"), []);
  assert.deepEqual(roleColumns(staleInactiveMulti, "multiY0"), []);
}

{
  const hiddenWrapFacet = deriveFields(
    makeGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        wrap: { name: "facet_col", type: "nominal" },
      },
      hiddenGroups: ["facet-a"],
    }),
  );
  assert.deepEqual(roleColumns(hiddenWrapFacet, "group"), ["facet_col"]);
  assert.deepEqual(roleColumns(hiddenWrapFacet, "wrap"), ["facet_col"]);
}

{
  const staleUnused = deriveFields(
    makeGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        size: { name: "size_unused", type: "continuous" },
        color: { name: "color_unused", type: "nominal" },
        wrap: { name: "wrap_unused", type: "nominal" },
      },
      elements: [{ kind: "line", enabled: true }],
      filters: [
        {
          id: "f1",
          op: "AND",
          rule: {
            kind: "categorical",
            field: { name: "category_filter", type: "nominal" },
            selected: ["A"],
            exclude: false,
          },
        },
      ],
    }),
  );

  assert.deepEqual(roleColumns(staleUnused, "size"), []);
  assert.deepEqual(roleColumns(staleUnused, "group"), ["color_unused"]);
  assert.deepEqual(roleColumns(staleUnused, "filter"), ["category_filter"]);

  const pointsWithSize = deriveFields(
    makeGraphBuilderItem({
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        size: { name: "point_size", type: "continuous" },
      },
      elements: [{ kind: "points", enabled: true }],
    }),
  );
  assert.deepEqual(roleColumns(pointsWithSize, "size"), ["point_size"]);

  const no3DElement = deriveFields(
    makeGraphBuilderItem({
      threeD: true,
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        z: { name: "z_unused", type: "continuous" },
      },
      elements: [{ kind: "line", enabled: true }],
    }),
  );
  assert.deepEqual(roleColumns(no3DElement, "z"), []);

  const with3DElement = deriveFields(
    makeGraphBuilderItem({
      threeD: true,
      encoding: {
        x: { name: "x", type: "continuous" },
        y: { name: "y", type: "continuous" },
        z: { name: "z", type: "continuous" },
      },
      elements: [{ kind: "scatter3d", enabled: true }],
    }),
  );
  assert.deepEqual(roleColumns(with3DElement, "z"), ["z"]);
}

console.log("graph-data fixture + decoder passed");
