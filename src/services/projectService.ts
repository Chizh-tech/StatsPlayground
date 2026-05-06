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
};
