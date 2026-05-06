/**
 * 图表构建器全局状态。
 *
 * 与 useDataStore（数据表）平行，统一构成项目目录。
 */

import { create } from "zustand";
import type { GraphBuilderItem } from "@/types/graphBuilder";

interface GraphBuilderStore {
  items: GraphBuilderItem[];
  addItem: (item: GraphBuilderItem) => void;
  updateItem: (id: string, patch: Partial<GraphBuilderItem>) => void;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  /** 删除某数据表时联动删除其所有图表 */
  deleteByDataset: (datasetId: string) => void;
  /** 从项目文件批量加载 */
  loadFromProject: (items: GraphBuilderItem[]) => void;
  /** 重置（关闭项目） */
  reset: () => void;
  /** 自增计数器（用于默认命名） */
  counter: number;
  bumpCounter: (n: number) => void;
}

export const useGraphBuilderStore = create<GraphBuilderStore>((set) => ({
  items: [],
  counter: 0,
  addItem: (item) => set((s) => ({ items: [...s.items, item] })),
  updateItem: (id, patch) =>
    set((s) => ({
      items: s.items.map((it) => (it.id === id ? { ...it, ...patch } : it)),
    })),
  renameItem: (id, name) =>
    set((s) => ({
      items: s.items.map((it) => (it.id === id ? { ...it, name } : it)),
    })),
  deleteItem: (id) =>
    set((s) => ({ items: s.items.filter((it) => it.id !== id) })),
  deleteByDataset: (datasetId) =>
    set((s) => ({
      items: s.items.filter((it) => it.sourceDatasetId !== datasetId),
    })),
  loadFromProject: (items) =>
    set(() => {
      const maxNum = items.reduce((m, it) => {
        const match = it.name.match(/^图表(\d+)$/);
        return match ? Math.max(m, parseInt(match[1], 10)) : m;
      }, 0);
      return { items, counter: maxNum };
    }),
  reset: () => set({ items: [], counter: 0 }),
  bumpCounter: (n) => set({ counter: n }),
}));
