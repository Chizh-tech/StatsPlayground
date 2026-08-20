import type { TableWindowFilter } from "./data";

export interface GraphFieldBinding {
  role: string;
  column: string;
}

export interface GraphElementRequest {
  kind: string;
  summaryStat: string;
}

export type GraphSampling =
  | { mode: "full" }
  | { mode: "sample"; size: number; seed: number };

export interface GraphViewport {
  width: number;
  height: number;
}

export interface GraphDataRequest {
  requestId: string;
  datasetId: string;
  generation: number;
  fields: GraphFieldBinding[];
  filters: TableWindowFilter[];
  elements: GraphElementRequest[];
  sampling: GraphSampling;
  viewport: GraphViewport;
}

export type GraphPayloadType = "f64" | "u32" | "i64" | "u8";

export interface GraphTypedSliceDescriptor {
  type: GraphPayloadType;
  offset: number;
  byteLength: number;
}

export type GraphAxisEncoding = "numeric" | "categorical";

export interface GraphChunkHeader {
  requestId: string;
  generation: number;
  chunkIndex: number;
  rowOffset: number;
  rowCount: number;
  sourceRows: number;
  processedRows: number;
  dictionaries: Record<string, readonly string[]>;
  validityRanges: Record<string, GraphTypedSliceDescriptor>;
  xValues: GraphTypedSliceDescriptor;
  yValues: GraphTypedSliceDescriptor;
  rowIds: GraphTypedSliceDescriptor;
  groupCodes?: GraphTypedSliceDescriptor;
  sizeValues?: GraphTypedSliceDescriptor;
  xEncoding: GraphAxisEncoding;
  finalChunk: boolean;
}

export interface GraphDataCompletion {
  requestId: string;
  datasetId: string;
  generation: number;
  sourceRows: number;
  processedRows: number;
  chunksSent: number;
  cancelled: boolean;
}

export interface GraphChunkMessage {
  header: GraphChunkHeader;
  payload: ArrayBuffer;
}

export interface HistogramBin {
  group?: string;
  category?: string;
  sourceColumn?: string;
  binStart: number;
  binEnd: number;
  count: number;
}

export interface HistogramPacket {
  kind: "histogram";
  xColumn?: string;
  yColumn: string;
  groupColumn?: string;
  sourceColumn?: string;
  binWidth: number;
  totalCount: number;
  bins: HistogramBin[];
}

export interface HeatmapCell {
  group?: string;
  xBinStart: number;
  xBinEnd: number;
  yBinStart: number;
  yBinEnd: number;
  count: number;
}

export interface HeatmapPacket {
  kind: "heatmap";
  xColumn: string;
  yColumn: string;
  groupColumn?: string;
  xBinWidth: number;
  yBinWidth: number;
  totalCount: number;
  cells: HeatmapCell[];
}

export interface BoxPlotEntry {
  group?: string;
  category?: string;
  sourceColumn?: string;
  count: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
  whiskerLow: number;
  whiskerHigh: number;
  outliers: number[];
}

export interface BoxPlotPacket {
  kind: "boxPlot";
  xColumn?: string;
  yColumn: string;
  groupColumn?: string;
  sourceColumn?: string;
  entries: BoxPlotEntry[];
}

export interface SummaryEntry {
  group?: string;
  category?: string;
  sourceColumn?: string;
  count: number;
  mean: number;
  stddev: number;
  min: number;
  max: number;
  intervalLow?: number;
  intervalHigh?: number;
}

export interface SummaryPacket {
  kind: "summary";
  xColumn?: string;
  yColumn: string;
  groupColumn?: string;
  sourceColumn?: string;
  summaries: SummaryEntry[];
}

export type GraphAggregatePacket =
  | HistogramPacket
  | HeatmapPacket
  | BoxPlotPacket
  | SummaryPacket;

export function isGraphAggregatePacket(value: unknown): value is GraphAggregatePacket {
  if (!value || typeof value !== "object") {
    return false;
  }

  const packet = value as Record<string, unknown>;
  return packet.kind === "histogram"
    || packet.kind === "heatmap"
    || packet.kind === "boxPlot"
    || packet.kind === "summary";
}

export interface DecodedRawPointChunk {
  chunkIndex: number;
  rowOffset: number;
  rowCount: number;
  xValues: Float64Array | Uint32Array;
  yValues: Float64Array;
  rowIds: BigInt64Array;
  groupCodes?: Uint32Array;
  sizeValues?: Float64Array;
  validity: Record<string, Uint8Array>;
}

export interface GraphDataFrame {
  requestId: string;
  datasetId: string;
  generation: number;
  sourceRows: number;
  processedRows: number;
  sampling: GraphSampling;
  dictionaries: Record<string, readonly string[]>;
  extents: Record<string, { min: number; max: number }>;
  rawChunks: readonly DecodedRawPointChunk[];
  aggregates: readonly GraphAggregatePacket[];
}

export interface DecodedGraphChunk extends DecodedRawPointChunk {
  requestId: string;
  generation: number;
  sourceRows: number;
  processedRows: number;
  dictionaries: Record<string, readonly string[]>;
  xEncoding: GraphAxisEncoding;
  finalChunk: boolean;
}

export class GraphPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GraphPayloadError";
  }
}

const TYPE_WIDTH: Record<GraphPayloadType, number> = {
  f64: 8,
  u32: 4,
  i64: 8,
  u8: 1,
};

function validateDescriptor(
  descriptor: GraphTypedSliceDescriptor,
  label: string,
  payloadLength: number,
): [start: number, end: number] {
  if (!Number.isInteger(descriptor.offset) || descriptor.offset < 0) {
    throw new GraphPayloadError(`${label} offset must be a non-negative integer`);
  }
  if (!Number.isInteger(descriptor.byteLength) || descriptor.byteLength < 0) {
    throw new GraphPayloadError(`${label} byteLength must be a non-negative integer`);
  }
  if (descriptor.offset % 8 !== 0) {
    throw new GraphPayloadError(`${label} offset ${descriptor.offset} is not 8-byte aligned`);
  }

  const width = TYPE_WIDTH[descriptor.type];
  if (descriptor.offset % width !== 0) {
    throw new GraphPayloadError(`${label} offset ${descriptor.offset} is misaligned for ${descriptor.type}`);
  }
  if (descriptor.byteLength % width !== 0) {
    throw new GraphPayloadError(`${label} byteLength ${descriptor.byteLength} is invalid for ${descriptor.type}`);
  }

  const end = descriptor.offset + descriptor.byteLength;
  if (!Number.isSafeInteger(end) || end > payloadLength) {
    throw new GraphPayloadError(`${label} range exceeds payload length`);
  }

  return [descriptor.offset, end];
}

function assertType(
  descriptor: GraphTypedSliceDescriptor,
  expected: GraphPayloadType | readonly GraphPayloadType[],
  label: string,
): void {
  const allowed = Array.isArray(expected) ? expected : [expected];
  if (!allowed.includes(descriptor.type)) {
    throw new GraphPayloadError(`${label} expected ${allowed.join("|")} but got ${descriptor.type}`);
  }
}

function descriptorElementCount(descriptor: GraphTypedSliceDescriptor): number {
  return descriptor.byteLength / TYPE_WIDTH[descriptor.type];
}

function assertRowVectorCardinality(
  descriptor: GraphTypedSliceDescriptor,
  rowCount: number,
  label: string,
): void {
  const elementCount = descriptorElementCount(descriptor);
  if (elementCount !== rowCount) {
    throw new GraphPayloadError(
      `${label} element count ${elementCount} must equal rowCount ${rowCount}`,
    );
  }
}

export function decodeGraphPayload(
  header: GraphChunkHeader,
  payload: ArrayBuffer,
): DecodedGraphChunk {
  if (!Number.isInteger(header.rowCount) || header.rowCount < 0) {
    throw new GraphPayloadError("rowCount must be a non-negative integer");
  }

  assertType(header.xValues, ["f64", "u32"], "xValues");
  assertType(header.yValues, "f64", "yValues");
  assertType(header.rowIds, "i64", "rowIds");

  if (header.groupCodes) {
    assertType(header.groupCodes, "u32", "groupCodes");
  }
  if (header.sizeValues) {
    assertType(header.sizeValues, "f64", "sizeValues");
  }

  const ranges: Array<{ start: number; end: number; label: string }> = [];
  const payloadLength = payload.byteLength;

  const register = (descriptor: GraphTypedSliceDescriptor, label: string): void => {
    const [start, end] = validateDescriptor(descriptor, label, payloadLength);
    ranges.push({ start, end, label });
  };

  register(header.xValues, "xValues");
  register(header.yValues, "yValues");
  register(header.rowIds, "rowIds");
  if (header.groupCodes) {
    register(header.groupCodes, "groupCodes");
  }
  if (header.sizeValues) {
    register(header.sizeValues, "sizeValues");
  }

  for (const [key, descriptor] of Object.entries(header.validityRanges)) {
    assertType(descriptor, "u8", `validityRanges.${key}`);
    register(descriptor, `validityRanges.${key}`);
  }

  ranges.sort((a, b) => a.start - b.start);
  for (let index = 1; index < ranges.length; index += 1) {
    const previous = ranges[index - 1];
    const current = ranges[index];
    if (previous.end > current.start) {
      throw new GraphPayloadError(
        `slice overlap between ${previous.label} and ${current.label}`,
      );
    }
  }

  assertRowVectorCardinality(header.xValues, header.rowCount, "xValues");
  assertRowVectorCardinality(header.yValues, header.rowCount, "yValues");
  assertRowVectorCardinality(header.rowIds, header.rowCount, "rowIds");
  if (header.groupCodes) {
    assertRowVectorCardinality(header.groupCodes, header.rowCount, "groupCodes");
  }
  if (header.sizeValues) {
    assertRowVectorCardinality(header.sizeValues, header.rowCount, "sizeValues");
  }

  // Validity bitmaps may include trailing bytes for alignment or future metadata,
  // so we enforce a minimum length rather than exact equality.
  const minValidityBytes = Math.ceil(header.rowCount / 8);
  for (const [key, descriptor] of Object.entries(header.validityRanges)) {
    if (descriptor.byteLength < minValidityBytes) {
      throw new GraphPayloadError(
        `validityRanges.${key} byteLength ${descriptor.byteLength} is smaller than required minimum ${minValidityBytes} for rowCount ${header.rowCount}`,
      );
    }
  }

  const xValues =
    header.xValues.type === "f64"
      ? new Float64Array(payload, header.xValues.offset, header.xValues.byteLength / 8)
      : new Uint32Array(payload, header.xValues.offset, header.xValues.byteLength / 4);
  const yValues = new Float64Array(payload, header.yValues.offset, header.yValues.byteLength / 8);
  const rowIds = new BigInt64Array(payload, header.rowIds.offset, header.rowIds.byteLength / 8);
  const groupCodes = header.groupCodes
    ? new Uint32Array(payload, header.groupCodes.offset, header.groupCodes.byteLength / 4)
    : undefined;
  const sizeValues = header.sizeValues
    ? new Float64Array(payload, header.sizeValues.offset, header.sizeValues.byteLength / 8)
    : undefined;

  const validity: Record<string, Uint8Array> = {};
  for (const [key, descriptor] of Object.entries(header.validityRanges)) {
    validity[key] = new Uint8Array(payload, descriptor.offset, descriptor.byteLength);
  }

  return {
    requestId: header.requestId,
    generation: header.generation,
    chunkIndex: header.chunkIndex,
    rowOffset: header.rowOffset,
    rowCount: header.rowCount,
    sourceRows: header.sourceRows,
    processedRows: header.processedRows,
    dictionaries: header.dictionaries,
    xEncoding: header.xEncoding,
    finalChunk: header.finalChunk,
    xValues,
    yValues,
    rowIds,
    groupCodes,
    sizeValues,
    validity,
  };
}