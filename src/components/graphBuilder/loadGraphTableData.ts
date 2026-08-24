export const GRAPH_TABLE_PAGE_SIZE = 2000;

export interface GraphTablePage {
  columns: string[];
  rows: unknown[][];
  totalRows: number;
  generation: number;
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
    if (rows.length >= result.totalRows || result.rows.length === 0) {
      return { columns, rows };
    }

    await (options.yieldToBrowser ?? yieldToBrowser)();
    if (options.signal.aborted) return null;
  }
}
