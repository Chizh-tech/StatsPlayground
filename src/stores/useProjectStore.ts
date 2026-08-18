import { create } from "zustand";
import type { ProjectInfo, OpenProjectResult } from "@/types/project";
import { projectService, type SaveProjectFolders } from "@/services/projectService";

interface ProjectStore {
  /** 当前打开的项目 */
  project: ProjectInfo | null;
  /** 加载中 */
  loading: boolean;
  /** 是否有未保存的修改 */
  dirty: boolean;
  /** 初始化项目（内存中，未保存到磁盘） */
  initProject: () => Promise<void>;
  /** 创建新项目 */
  createProject: (name: string, filePath: string) => Promise<void>;
  /** 打开已有项目，返回历史/快照数据 */
  openProject: (filePath: string) => Promise<OpenProjectResult>;
  /** 保存项目（可传入文件路径用于首次保存；folders 携带目录树与归属映射）。 */
  saveProject: (
    filePath?: string,
    history?: unknown[],
    snapshots?: unknown[],
    graphBuilders?: unknown[],
    folders?: SaveProjectFolders,
  ) => Promise<void>;
  /** 关闭项目 */
  closeProject: () => void;
  /** 标记有未保存的修改 */
  markDirty: () => void;
}

export const useProjectStore = create<ProjectStore>((set) => ({
  project: null,
  loading: false,
  dirty: false,

  initProject: async () => {
    set({ loading: true });
    const project = await projectService.initProject();
    set({ project, loading: false, dirty: false });
  },

  createProject: async (name, filePath) => {
    set({ loading: true });
    const project = await projectService.createProject(name, filePath);
    set({ project, loading: false, dirty: false });
  },

  openProject: async (filePath) => {
    set({ loading: true });
    try {
      const result = await projectService.openProject(filePath);
      set({
        project: result.project,
        dirty: result.datasetNameMigrations.length > 0,
      });
      return result;
    } finally {
      set({ loading: false });
    }
  },

  saveProject: async (filePath, history, snapshots, graphBuilders, folders) => {
    const project = await projectService.saveProject(
      filePath,
      history,
      snapshots,
      graphBuilders,
      folders,
    );
    set({ project, dirty: false });
  },

  closeProject: () => {
    set({ project: null, dirty: false });
  },

  markDirty: () => {
    set({ dirty: true });
  },
}));
