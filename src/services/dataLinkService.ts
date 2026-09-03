import { invoke } from "@tauri-apps/api/core";

import type { PreviewResult, SourceObject } from "@/types/dataLink";
import type { DatasetMeta } from "@/types/data";
import type { SqliteImportSelection } from "@/types/dataLink";

export const dataLinkService = {
  listSqliteObjects: (filePath: string) =>
    invoke<SourceObject[]>("list_sqlite_source_objects", { filePath }),

  previewSqliteObject: (filePath: string, objectName: string, limit = 100) =>
    invoke<PreviewResult>("preview_sqlite_source_object", { filePath, objectName, limit }),

  importSelectedSqlite: (filePath: string, requestId: string, selections: SqliteImportSelection[]) =>
    invoke<DatasetMeta[]>("import_selected_sqlite", { filePath, requestId, selections }),

  cancelSqliteImport: (requestId: string) =>
    invoke<void>("cancel_sqlite_import", { requestId }),
};
