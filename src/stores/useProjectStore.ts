import { create } from "zustand";
import type { ProjectInfo, OpenProjectResult } from "@/types/project";
import {
  projectService,
  type SaveProgress,
  type SaveProjectRequest,
} from "@/services/projectService";
import {
  assertProjectMutable,
  beginSaveState,
  completeSaveState,
  failSaveState,
  replaceSaveProgress,
} from "@/utils/saveReadOnly";

interface ProjectStore {
  /** 当前打开的项目 */
  project: ProjectInfo | null;
  /** 加载中 */
  loading: boolean;
  /** 是否有未保存的修改 */
  dirty: boolean;
  /** 保存进行中（用于禁用重复保存）。 */
  saving: boolean;
  /** 保存期间前端只读。 */
  readOnly: boolean;
  /** 保存进度（仅保存期间有效）。 */
  saveProgress: SaveProgress | null;
  /** 最近一次保存错误（保存失败时保留）。 */
  saveError: string | null;
  /** 初始化项目（内存中，未保存到磁盘） */
  initProject: () => Promise<void>;
  /** 创建新项目 */
  createProject: (name: string, filePath: string) => Promise<void>;
  /** 打开已有项目，返回历史/快照数据 */
  openProject: (filePath: string) => Promise<OpenProjectResult>;
  /** 保存项目（单请求对象，含可选 filePath 与目录归属映射）。 */
  saveProject: (request: SaveProjectRequest) => Promise<void>;
  /** 关闭项目 */
  closeProject: () => void;
  /** 标记有未保存的修改 */
  markDirty: () => void;
}

export const useProjectStore = create<ProjectStore>((set) => ({
  project: null,
  loading: false,
  dirty: false,
  saving: false,
  readOnly: false,
  saveProgress: null,
  saveError: null,

  initProject: async () => {
    set({ loading: true });
    const project = await projectService.initProject();
    set({ project, loading: false, dirty: false, saveError: null });
  },

  createProject: async (name, filePath) => {
    set({ loading: true });
    const project = await projectService.createProject(name, filePath);
    set({ project, loading: false, dirty: false, saveError: null });
  },

  openProject: async (filePath) => {
    set({ loading: true });
    try {
      const result = await projectService.openProject(filePath);
      set({
        project: result.project,
        dirty: result.datasetNameMigrations.length > 0,
        saveError: null,
      });
      return result;
    } finally {
      set({ loading: false });
    }
  },

  saveProject: async (request) => {
    set((state) => ({
      ...beginSaveState({
        dirty: state.dirty,
        saving: state.saving,
        readOnly: state.readOnly,
        saveProgress: state.saveProgress,
      }),
      saveError: null,
    }));
    try {
      const project = await projectService.saveProject(request, (progress) => {
        set((state) => ({
          saveProgress: replaceSaveProgress(state.saveProgress, progress),
        }));
      });
      set((state) => ({
        project,
        ...completeSaveState({
          dirty: state.dirty,
          saving: state.saving,
          readOnly: state.readOnly,
          saveProgress: state.saveProgress,
        }),
        saveError: null,
      }));
    } catch (error) {
      set((state) => ({
        ...failSaveState({
          dirty: state.dirty,
          saving: state.saving,
          readOnly: state.readOnly,
          saveProgress: state.saveProgress,
        }),
        saveError: String(error),
      }));
      throw error;
    } finally {
      set({ saving: false, readOnly: false, saveProgress: null });
    }
  },

  closeProject: () => {
    set({
      project: null,
      dirty: false,
      saving: false,
      readOnly: false,
      saveProgress: null,
      saveError: null,
    });
  },

  markDirty: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set({ dirty: true });
  },
}));
