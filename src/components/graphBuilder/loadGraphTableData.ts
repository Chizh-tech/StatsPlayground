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

interface LoadGraphTableDataOptions {
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
  onProgress?: (progress: GraphTableLoadProgress) => void;
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export async function loadGraphTableData(
  options: LoadGraphTableDataOptions,
): Promise<GraphTableData | null> {
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
    if (rows.length >= result.totalRows || result.rows.length === 0) {
      return { columns, rows };
    }

    await (options.yieldToBrowser ?? yieldToBrowser)();
    if (options.signal.aborted) return null;
  }
}
