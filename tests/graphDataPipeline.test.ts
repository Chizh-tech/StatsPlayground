import assert from "node:assert/strict";
import { decodeGraphPayload, isGraphAggregatePacket } from "../src/types/graphData.ts";
import {
  createInitialGraphStreamState,
  reduceGraphStream,
  type GraphStreamState,
} from "../src/components/graphBuilder/useGraphDataPipeline.ts";
import type {
  GraphChunkHeader,
  GraphDataCompletion,
  GraphDataRequest,
  GraphDataFrame,
} from "../src/types/graphData.ts";

export function makeGraphRows(count: number): Array<[number, string, number]> {
  return Array.from({ length: count }, (_, index) => [
    index + 1,
    ["Central", "East", "North", "South", "West"][index % 5],
    (index * 37) % 7200,
  ]);
}

assert.equal(makeGraphRows(10).length, 10);

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

assert.equal(isGraphAggregatePacket({ kind: "histogram" }), true);
assert.equal(isGraphAggregatePacket({ kind: "histogram", payload: {} }), false);

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

function run(state: GraphStreamState, ...messages: Parameters<typeof reduceGraphStream>[1][]): GraphStreamState {
  let next = state;
  for (const message of messages) {
    next = reduceGraphStream(next, message);
  }
  return next;
}

{
  const initial = createInitialGraphStreamState(makeCommittedFrame());
  const request = makeRequest("req-atomic", 7);
  const afterChunks = run(
    initial,
    { type: "start", request },
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
  assert.equal(committed.error, null);
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
  assert.match(state.error ?? "", /duplicate/i);
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

console.log("graph-data fixture + decoder passed");
