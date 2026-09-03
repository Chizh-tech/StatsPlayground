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
  action: "create" | "append";
}
