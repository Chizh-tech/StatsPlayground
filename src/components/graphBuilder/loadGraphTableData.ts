export const GRAPH_TABLE_PAGE_SIZE = 4096;

export interface GraphTablePage {
  columns: string[];
  rows: unknown[][];
  totalRows: number;
}

export interface GraphTableData {
  columns: string[];
  rows: unknown[][];
}

interface LoadGraphTableDataOptions {
  datasetId: string;
  signal: AbortSignal;
  queryPage: (
    datasetId: string,
    page: number,
    pageSize: number,
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

  for (let page = 0; ; page += 1) {
    if (options.signal.aborted) return null;
    const result = await options.queryPage(
      options.datasetId,
      page,
      GRAPH_TABLE_PAGE_SIZE,
    );
    if (options.signal.aborted) return null;

    if (page === 0) columns = result.columns;
    rows.push(...result.rows);
    if (rows.length >= result.totalRows || result.rows.length === 0) {
      return { columns, rows };
    }

    await (options.yieldToBrowser ?? yieldToBrowser)();
    if (options.signal.aborted) return null;
  }
}
