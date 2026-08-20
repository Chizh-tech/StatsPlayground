export interface RawPointChunkViews {
  xValues: Float64Array | Uint32Array;
  yValues: Float64Array;
  rowIds: BigInt64Array;
  xValidity?: Uint8Array;
  yValidity?: Uint8Array;
  facetMask?: Uint8Array;
}

export type RawPointJitter =
  | { mode: "none" }
  | { mode: "seeded"; seed: number; amplitudePx: number };

export interface RawPointPanelDescriptor {
  colName: string;
  xCategories?: readonly string[];
  jitter?: RawPointJitter;
  chunks: readonly RawPointChunkViews[];
}

export interface NumericProjector {
  kind: "numeric";
  scale: number;
  offset: number;
}

export interface CategoricalProjector {
  kind: "categorical";
  pixelsByCategory: Float64Array;
}

export interface RawPointProjector {
  plotRect: { x: number; y: number; width: number; height: number };
  x: NumericProjector | CategoricalProjector;
  y: NumericProjector;
}

export interface DrawnRawPoint {
  px: number;
  py: number;
  rowId: bigint;
  colName: string;
}

export interface DrawRawPointsResult {
  totalRows: number;
  drawnRows: number;
  points: DrawnRawPoint[];
}

export interface RawPointPick {
  rowId: bigint;
  colName: string;
}

export interface RawPointHit {
  topmost: RawPointPick;
  overlaps: RawPointPick[];
}

export interface RawPointPixelIndex {
  width: number;
  height: number;
  cellStarts: Uint32Array;
  cellCounts: Uint32Array;
  sourceOffsets: Uint32Array;
  sourceRowIds: BigInt64Array;
  sourceColNames: string[];
}

function bitIsSet(bitmap: Uint8Array | undefined, rowIndex: number): boolean {
  if (!bitmap) return true;
  const byteIndex = rowIndex >> 3;
  if (byteIndex >= bitmap.length) return false;
  const mask = 1 << (rowIndex & 7);
  return (bitmap[byteIndex] & mask) !== 0;
}

function makeXorShift32(seed: number): () => number {
  let x = (seed | 0) ^ 0x9e3779b9;
  if (x === 0) x = 0x6d2b79f5;
  return () => {
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    return ((x >>> 0) & 0xffffffff) / 0x100000000;
  };
}

function projectX(projector: RawPointProjector["x"], rawValue: number): number {
  if (projector.kind === "numeric") {
    return projector.scale * rawValue + projector.offset;
  }
  const idx = rawValue >>> 0;
  if (idx >= projector.pixelsByCategory.length) return Number.NaN;
  return projector.pixelsByCategory[idx];
}

function buildJitter(
  jitter: RawPointJitter | undefined,
): { active: false } | { active: true; rand: () => number; amplitude: number } {
  if (!jitter || jitter.mode === "none") return { active: false };
  const amplitude = Math.max(0, Number.isFinite(jitter.amplitudePx) ? jitter.amplitudePx : 0);
  if (amplitude <= 0) return { active: false };
  return {
    active: true,
    rand: makeXorShift32(Math.trunc(jitter.seed)),
    amplitude,
  };
}

export function drawRawPoints(
  descriptor: RawPointPanelDescriptor,
  projector: RawPointProjector,
): DrawRawPointsResult {
  const points: DrawnRawPoint[] = [];
  let totalRows = 0;
  const xMin = projector.plotRect.x;
  const yMin = projector.plotRect.y;
  const xMax = projector.plotRect.x + projector.plotRect.width;
  const yMax = projector.plotRect.y + projector.plotRect.height;
  const jitter = buildJitter(descriptor.jitter);

  for (let ci = 0; ci < descriptor.chunks.length; ci += 1) {
    const chunk = descriptor.chunks[ci];
    const n = Math.min(chunk.xValues.length, chunk.yValues.length, chunk.rowIds.length);
    totalRows += n;
    for (let row = 0; row < n; row += 1) {
      if (!bitIsSet(chunk.xValidity, row)) continue;
      if (!bitIsSet(chunk.yValidity, row)) continue;
      if (!bitIsSet(chunk.facetMask, row)) continue;

      const xRaw = Number(chunk.xValues[row]);
      const yRaw = Number(chunk.yValues[row]);
      if (!Number.isFinite(xRaw) || !Number.isFinite(yRaw)) continue;

      const pxFloat = projectX(projector.x, xRaw);
      const pyFloat = projector.y.scale * yRaw + projector.y.offset;
      if (!Number.isFinite(pxFloat) || !Number.isFinite(pyFloat)) continue;

      const dx = jitter.active ? (jitter.rand() * 2 - 1) * jitter.amplitude : 0;
      const px = Math.round(pxFloat + dx);
      const py = Math.round(pyFloat);
      if (px < xMin || px > xMax || py < yMin || py > yMax) continue;

      points.push({
        px,
        py,
        rowId: chunk.rowIds[row],
        colName: descriptor.colName,
      });
    }
  }

  return {
    totalRows,
    drawnRows: points.length,
    points,
  };
}

export function buildPixelIndex(
  width: number,
  height: number,
  points: readonly DrawnRawPoint[],
): RawPointPixelIndex {
  const w = Math.max(1, Math.trunc(width));
  const h = Math.max(1, Math.trunc(height));
  const cellCount = w * h;
  const counts = new Uint32Array(cellCount);

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    if (point.px < 0 || point.py < 0 || point.px >= w || point.py >= h) continue;
    counts[point.py * w + point.px] += 1;
  }

  const starts = new Uint32Array(cellCount);
  let total = 0;
  for (let i = 0; i < cellCount; i += 1) {
    starts[i] = total;
    total += counts[i];
  }

  const sourceOffsets = new Uint32Array(total);
  const writeCursor = starts.slice();
  const sourceRowIds = new BigInt64Array(points.length);
  const sourceColNames = new Array<string>(points.length);

  for (let i = 0; i < points.length; i += 1) {
    const point = points[i];
    sourceRowIds[i] = point.rowId;
    sourceColNames[i] = point.colName;
    if (point.px < 0 || point.py < 0 || point.px >= w || point.py >= h) continue;
    const cell = point.py * w + point.px;
    const pos = writeCursor[cell]++;
    sourceOffsets[pos] = i;
  }

  return {
    width: w,
    height: h,
    cellStarts: starts,
    cellCounts: counts,
    sourceOffsets,
    sourceRowIds,
    sourceColNames,
  };
}

export function hitTestPoint(
  index: RawPointPixelIndex,
  px: number,
  py: number,
): RawPointHit | null {
  const x = Math.trunc(px);
  const y = Math.trunc(py);
  if (x < 0 || y < 0 || x >= index.width || y >= index.height) return null;
  const cell = y * index.width + x;
  const count = index.cellCounts[cell];
  if (!count) return null;
  const start = index.cellStarts[cell];
  const overlaps: RawPointPick[] = new Array(count);
  for (let i = 0; i < count; i += 1) {
    const sourceOffset = index.sourceOffsets[start + i];
    overlaps[i] = {
      rowId: index.sourceRowIds[sourceOffset],
      colName: index.sourceColNames[sourceOffset],
    };
  }
  return {
    topmost: overlaps[overlaps.length - 1],
    overlaps,
  };
}

export function hitTestBrush(
  index: RawPointPixelIndex,
  rect: { x1: number; y1: number; x2: number; y2: number },
): RawPointPick[] {
  const minX = Math.max(0, Math.trunc(Math.min(rect.x1, rect.x2)));
  const maxX = Math.min(index.width - 1, Math.trunc(Math.max(rect.x1, rect.x2)));
  const minY = Math.max(0, Math.trunc(Math.min(rect.y1, rect.y2)));
  const maxY = Math.min(index.height - 1, Math.trunc(Math.max(rect.y1, rect.y2)));
  if (maxX < minX || maxY < minY) return [];

  const seenByKey = new Set<string>();
  const sourceOffsets: number[] = [];
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const cell = y * index.width + x;
      const count = index.cellCounts[cell];
      if (!count) continue;
      const start = index.cellStarts[cell];
      for (let i = 0; i < count; i += 1) {
        const sourceOffset = index.sourceOffsets[start + i];
        const rowId = index.sourceRowIds[sourceOffset];
        const colName = index.sourceColNames[sourceOffset];
        const key = `${rowId.toString()}|${colName}`;
        if (seenByKey.has(key)) continue;
        seenByKey.add(key);
        sourceOffsets.push(sourceOffset);
      }
    }
  }
  sourceOffsets.sort((a, b) => a - b);
  return sourceOffsets.map((sourceOffset) => ({
    rowId: index.sourceRowIds[sourceOffset],
    colName: index.sourceColNames[sourceOffset],
  }));
}

export function rasterizeToRgba(
  width: number,
  height: number,
  descriptor: RawPointPanelDescriptor,
  projector: RawPointProjector,
  rgba: readonly [number, number, number, number] = [26, 131, 255, 255],
): Uint8ClampedArray {
  const w = Math.max(1, Math.trunc(width));
  const h = Math.max(1, Math.trunc(height));
  const out = new Uint8ClampedArray(w * h * 4);
  const drawn = drawRawPoints(descriptor, projector);
  for (let i = 0; i < drawn.points.length; i += 1) {
    const p = drawn.points[i];
    if (p.px < 0 || p.py < 0 || p.px >= w || p.py >= h) continue;
    const idx = (p.py * w + p.px) * 4;
    out[idx] = rgba[0];
    out[idx + 1] = rgba[1];
    out[idx + 2] = rgba[2];
    out[idx + 3] = rgba[3];
  }
  return out;
}

export function stableRgbaDigest(rgba: Uint8ClampedArray): string {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (let i = 0; i < rgba.length; i += 1) {
    hash ^= BigInt(rgba[i]);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, "0");
}
