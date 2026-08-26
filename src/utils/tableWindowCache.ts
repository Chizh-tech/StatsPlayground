import type { TableWindowRequest, TableWindowResult } from "@/types/data";

interface CacheEntry {
  datasetId: string;
  generation: number;
  queryKey: string;
  result: TableWindowResult;
  lastUsed: number;
}

function queryKey(request: TableWindowRequest): string {
  return JSON.stringify({
    datasetId: request.datasetId,
    generation: request.generation,
    sort: request.sort,
    filters: request.filters,
  });
}

export class TableWindowCache {
  private readonly entries = new Map<string, CacheEntry>();
  private readonly maxRows: number;
  private clock = 0;
  private rowCount = 0;

  constructor(maxRows: number) {
    if (!Number.isInteger(maxRows) || maxRows < 1) {
      throw new RangeError("maxRows must be a positive integer");
    }
    this.maxRows = maxRows;
  }

  get retainedRows(): number {
    return this.rowCount;
  }

  put(request: TableWindowRequest, result: TableWindowResult): boolean {
    if (
      result.start !== request.start
      || result.generation !== request.generation
      || result.rows.length > request.count
      || result.rows.length > this.maxRows
    ) {
      return false;
    }

    const key = `${queryKey(request)}:${request.start}`;
    const previous = this.entries.get(key);
    if (previous) {
      this.rowCount -= previous.result.rows.length;
    }
    this.entries.set(key, {
      datasetId: request.datasetId,
      generation: request.generation,
      queryKey: queryKey(request),
      result,
      lastUsed: ++this.clock,
    });
    this.rowCount += result.rows.length;
    this.evictLeastRecentlyUsed();
    return true;
  }

  get(request: TableWindowRequest): TableWindowResult | undefined {
    const key = queryKey(request);
    const matching = [...this.entries.values()]
      .filter((entry) => entry.queryKey === key)
      .sort((left, right) => left.result.start - right.result.start);
    if (matching.length === 0) {
      return undefined;
    }

    const first = matching[0];
    const targetEnd = Math.min(request.start + request.count, first.result.totalRows);
    const rows: unknown[][] = [];
    const used = new Set<CacheEntry>();
    let position = request.start;

    while (position < targetEnd) {
      const entry = matching.find((candidate) => {
        const end = candidate.result.start + candidate.result.rows.length;
        return candidate.result.start <= position && position < end;
      });
      if (!entry) {
        return undefined;
      }
      const offset = position - entry.result.start;
      const available = Math.min(entry.result.rows.length - offset, targetEnd - position);
      rows.push(...entry.result.rows.slice(offset, offset + available));
      position += available;
      used.add(entry);
    }

    for (const entry of used) {
      entry.lastUsed = ++this.clock;
    }
    return {
      columns: first.result.columns,
      columnTypes: first.result.columnTypes,
      rows,
      totalRows: first.result.totalRows,
      start: request.start,
      generation: request.generation,
    };
  }

  invalidateRange(
    datasetId: string,
    generation: number,
    start: number,
    count: number,
  ): void {
    const end = start + count;
    for (const [key, entry] of this.entries) {
      const entryEnd = entry.result.start + entry.result.rows.length;
      if (
        entry.datasetId === datasetId
        && entry.generation === generation
        && entry.result.start < end
        && start < entryEnd
      ) {
        this.entries.delete(key);
        this.rowCount -= entry.result.rows.length;
      }
    }
  }

  clear(): void {
    this.entries.clear();
    this.rowCount = 0;
  }

  private evictLeastRecentlyUsed(): void {
    while (this.rowCount > this.maxRows) {
      let oldestKey: string | undefined;
      let oldestEntry: CacheEntry | undefined;
      for (const [key, entry] of this.entries) {
        if (!oldestEntry || entry.lastUsed < oldestEntry.lastUsed) {
          oldestKey = key;
          oldestEntry = entry;
        }
      }
      if (!oldestKey || !oldestEntry) {
        return;
      }
      this.entries.delete(oldestKey);
      this.rowCount -= oldestEntry.result.rows.length;
    }
  }
}