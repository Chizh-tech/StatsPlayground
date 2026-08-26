export type TabulateStatisticKind =
  | "count"
  | "missingCount"
  | "uniqueCount"
  | "sum"
  | "mean"
  | "standardDeviation"
  | "variance"
  | "minimum"
  | "maximum"
  | "median"
  | "range"
  | "quantile"
  | "rowPercentage"
  | "columnPercentage"
  | "totalPercentage";

export interface TabulateStatistic {
  id: string;
  field: string;
  kind: TabulateStatisticKind;
  quantile?: number;
}

export interface TabulateItem {
  id: string;
  name: string;
  sourceDatasetId: string;
  rowFields: string[];
  columnFields: string[];
  statistics: TabulateStatistic[];
  includeRowTotals: boolean;
  includeColumnTotals: boolean;
  createdAt: string;
}

export interface TabulateRequest {
  datasetId: string;
  rowFields: string[];
  columnFields: string[];
  statistics: TabulateStatistic[];
  includeRowTotals: boolean;
  includeColumnTotals: boolean;
  maxResultCells: 10000;
}

export interface TabulateResult {
  rowMembers: unknown[][];
  columnMembers: unknown[][];
  statistics: TabulateStatistic[];
  cells: Array<number | null>;
  rowTotals: Array<number | null>;
  columnTotals: Array<number | null>;
  grandTotals: Array<number | null>;
  cellCount: number;
  limit: number;
}