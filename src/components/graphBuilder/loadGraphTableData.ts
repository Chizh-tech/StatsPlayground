export const GRAPH_TABLE_PAGE_SIZE = 2000;

export interface GraphTablePage {
  columns: string[];
  rows: unknown[][];
  totalRows: number;
  generation: number;
}

export interface GraphTableLoadProgress {
  loadedRows: number;
  totalRows: number;
}

export interface GraphTableData {
  columns: string[];
  rows: unknown[][];
}

export interface GraphTableDataCachePort {
  get(datasetId: string, generation: number): GraphTableData | undefined;
  putIfCurrent(epoch: number, datasetId: string, generation: number, data: GraphTableData): boolean;
}

interface LoadGraphTableDataBaseOptions {
  datasetId: string;
  generation: number;
  signal: AbortSignal;
  queryWindow: (
    datasetId: string,
    start: number,
    count: number,
    generation: number,
  ) => Promise<GraphTablePage>;
  yieldToBrowser?: () => Promise<void>;
  /**
   * Optional progress callback invoked synchronously immediately after a page
   * has passed the loader's cancellation and generation validation and its
   * rows have been appended to the accumulated result. Callers must keep this
   * callback lightweight and avoid doing expensive synchronous work inside it.
   * Do not queue the callback (for example with `queueMicrotask` or
   * `setTimeout`) — queued callbacks can outlive cancellation and violate the
   * loader's ordering guarantees.
   */
  onProgress?: (progress: GraphTableLoadProgress) => void;
}

type LoadGraphTableDataOptions = LoadGraphTableDataBaseOptions & (
  | {
      cache?: undefined;
      cacheEpoch?: never;
    }
  | {
      cache: GraphTableDataCachePort;
      cacheEpoch: number;
    }
);

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function loadGraphTableData(
  options: LoadGraphTableDataOptions,
): Promise<GraphTableData | null> {
  if (options.signal.aborted) return null;
  const cached = options.cache?.get(options.datasetId, options.generation);
  if (cached) return cached;

  const rows: unknown[][] = [];
  let columns: string[] = [];

  for (;;) {
    if (options.signal.aborted) return null;
    const result = await options.queryWindow(
      options.datasetId,
      rows.length,
      GRAPH_TABLE_PAGE_SIZE,
      options.generation,
    );
    if (options.signal.aborted) return null;
    if (result.generation !== options.generation) {
      throw new Error("Dataset changed during graph loading.");
    }

    if (rows.length === 0) columns = result.columns;
    rows.push(...result.rows);
    // emit progress after appending the page but only for accepted generation
    options.onProgress?.({
      loadedRows: Math.min(rows.length, result.totalRows),
      totalRows: result.totalRows,
    });
    if (result.rows.length === 0) {
      if (result.totalRows === 0) {
        const data = { columns, rows };
        if (options.cache) {
          options.cache.putIfCurrent(
            options.cacheEpoch,
            options.datasetId,
            options.generation,
            data,
          );
        }
        return data;
      }
      throw new Error("Incomplete graph table load: received an empty page before all rows loaded.");
    }

    if (rows.length >= result.totalRows) {
      const data = { columns, rows };
      if (options.cache) {
        options.cache.putIfCurrent(
          options.cacheEpoch,
          options.datasetId,
          options.generation,
          data,
        );
      }
      return data;
    }

    await (options.yieldToBrowser ?? yieldToBrowser)();
    if (options.signal.aborted) return null;
  }
}
