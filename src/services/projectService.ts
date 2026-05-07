import { invoke } from "@tauri-apps/api/core";
import type { ProjectInfo, OpenProjectResult } from "@/types/project";

export const projectService = {
  initProject: () =>
    invoke<ProjectInfo>("init_project"),

  createProject: (name: string, filePath: string) =>
    invoke<ProjectInfo>("create_project", { name, filePath }),

  openProject: (filePath: string) =>
    invoke<OpenProjectResult>("open_project", { filePath }),

  saveProject: (filePath?: string, history?: unknown[], snapshots?: unknown[], graphBuilders?: unknown[]) =>
    invoke<ProjectInfo>("save_project", {
      filePath: filePath ?? null,
      history: history ?? null,
      snapshots: snapshots ?? null,
      graphBuilders: graphBuilders ?? null,
    }),

  getCurrentProject: () => invoke<ProjectInfo | null>("get_current_project"),

  // ---- Single-table / single-graph share helpers --------------------------
  // .sptb = standalone table file, .spgh = standalone graph file. Both can
  // live by themselves on disk and can be re-imported into any project.

  /** Export one dataset to a `.sptb` file. */
  exportTable: (datasetId: string, filePath: string) =>
    invoke<void>("export_table", { datasetId, filePath }),

  /** Import a `.sptb` file. Returns the new dataset id assigned in the project. */
  importTable: (filePath: string) =>
    invoke<string>("import_table", { filePath }),

  /** Export an opaque graph builder config to a `.spgh` file. */
  exportGraph: (graph: unknown, filePath: string) =>
    invoke<void>("export_graph", { graph, filePath }),

  /** Import a `.spgh` file and return its graph builder body. */
  importGraph: (filePath: string) =>
    invoke<unknown>("import_graph", { filePath }),
};
