export interface SourceColumn {
  name: string;
  sourceType: string;
  nullable: boolean;
  primaryKey: boolean;
}

export interface SourceObject {
  name: string;
  objectType: "table" | "view";
  columns: SourceColumn[];
}

export interface PreviewResult {
  objectName: string;
  columns: SourceColumn[];
  rows: unknown[][];
  truncated: boolean;
}

export interface SqliteImportSelection {
  sourceName: string;
  targetName: string;
  action: "create" | "append" | "skip";
}

export interface ImportTableSummary {
  sourceName: string;
  targetName: string;
  action: "create" | "append" | "skip";
  rowsWritten: number;
}

export interface ImportSummary {
  status: "completed" | "failed" | "cancelled";
  imported: ImportTableSummary[];
  skipped: ImportTableSummary[];
  failedTable: string | null;
  error: string | null;
  totalRowsWritten: number;
}

export interface ImportProgress {
  tableName: string;
  tableIndex: number;
  tableTotal: number;
  rowsDone: number;
  rowsTotal: number;
}
