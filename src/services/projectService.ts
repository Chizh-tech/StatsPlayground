import { invoke } from "@tauri-apps/api/core";
import type { ProjectInfo, OpenProjectResult, ImportTableResult } from "@/types/project";

/** Optional folder payload accepted by the v2 save_project command.
 *  Per issue #7 the file bodies (.sptb / .spgh) carry no folder info; the
 *  folder a file lives in is encoded purely by its path inside the archive,
 *  which the backend derives from these maps. */
export interface SaveProjectFolders {
  /** All folder paths that exist in the project, including empty ones. */
  folders: string[];
  /** datasetId → folder path. Root datasets are simply absent. */
  tableFolders: Record<string, string>;
  /** graphId → folder path. Root graphs are simply absent. */
  graphFolders: Record<string, string>;
}

export const projectService = {
  initProject: () =>
    invoke<ProjectInfo>("init_project"),

  createProject: (name: string, filePath: string) =>
    invoke<ProjectInfo>("create_project", { name, filePath }),

  openProject: (filePath: string) =>
    invoke<OpenProjectResult>("open_project", { filePath }),

  saveProject: (
    filePath?: string,
    history?: unknown[],
    snapshots?: unknown[],
    graphBuilders?: unknown[],
    folders?: SaveProjectFolders,
  ) =>
    invoke<ProjectInfo>("save_project", {
      filePath: filePath ?? null,
      history: history ?? null,
      snapshots: snapshots ?? null,
      graphBuilders: graphBuilders ?? null,
      folders: folders?.folders ?? null,
      tableFolders: folders?.tableFolders ?? null,
      graphFolders: folders?.graphFolders ?? null,
    }),

  getCurrentProject: () => invoke<ProjectInfo | null>("get_current_project"),

  // ---- Single-table / single-graph share helpers --------------------------
  // .sptb = standalone table file, .spgh = standalone graph file. Both can
  // live by themselves on disk and can be re-imported into any project.

  /** Export one dataset to a `.sptb` file. */
  exportTable: (datasetId: string, filePath: string) =>
    invoke<void>("export_table", { datasetId, filePath }),

  /** Export multiple datasets as `.sptb` files packed into a `.zip`.
   *  `archivePaths` maps each dataset id to the file's path inside the zip
   *  (without `.sptb`), so the UI can mirror its folder tree. */
  exportTablesSptbZip: (
    datasetIds: string[],
    outputPath: string,
    archivePaths?: Record<string, string>,
  ) =>
    invoke<void>("export_tables_sptb_zip", {
      datasetIds,
      outputPath,
      archivePaths: archivePaths ?? null,
    }),

  /** Import a `.sptb` file. Returns the new dataset id assigned in the
   *  project. Per issue #7 the `.sptb` body carries no folder info; the
   *  caller decides where to place the imported table (defaults to root). */
  importTable: (filePath: string) =>
    invoke<ImportTableResult>("import_table", { filePath }),

  /** Export an opaque graph builder config to a `.spgh` file. */
  exportGraph: (graph: unknown, filePath: string) =>
    invoke<void>("export_graph", { graph, filePath }),

  /** Import a `.spgh` file and return its graph builder body. */
  importGraph: (filePath: string) =>
    invoke<unknown>("import_graph", { filePath }),
};
