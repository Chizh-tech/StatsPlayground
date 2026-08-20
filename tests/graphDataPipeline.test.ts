import assert from "node:assert/strict";
import { decodeGraphPayload, isGraphAggregatePacket } from "../src/types/graphData.ts";

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

console.log("graph-data fixture + decoder passed");
