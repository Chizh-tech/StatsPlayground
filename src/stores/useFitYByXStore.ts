import { create } from "zustand";

import { createFitYByXItem } from "@/components/fitYByX/fitYByXConfig";
import { useProjectStore } from "@/stores/useProjectStore";
import type { FitYByXItem } from "@/types/fitYByX";
import { assertProjectMutable } from "@/utils/saveReadOnly";

interface FitYByXStore {
  items: FitYByXItem[];
  counter: number;
  addItem: (item: FitYByXItem) => void;
  updateItem: (id: string, patch: Partial<FitYByXItem>) => void;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  deleteByDataset: (datasetId: string) => void;
  loadFromProject: (items: FitYByXItem[]) => void;
  reset: () => void;
  nextName: () => string;
}

const FIT_Y_BY_X_NAME_RE = /^Fit Y by X (\d+)$/;

function maxFitYByXSuffix(items: readonly FitYByXItem[]): number {
  return items.reduce((maxValue, item) => {
    const match = item.name.match(FIT_Y_BY_X_NAME_RE);
    if (!match) {
      return maxValue;
    }
    return Math.max(maxValue, Number.parseInt(match[1], 10));
  }, 0);
}

function normalizeLoadedItem(item: FitYByXItem): FitYByXItem {
  return createFitYByXItem({
    id: item.id,
    name: item.name,
    sourceDatasetId: item.sourceDatasetId,
    response: item.response,
    factor: item.factor,
    createdAt: item.createdAt,
  });
}

export const useFitYByXStore = create<FitYByXStore>((set, get) => ({
  items: [],
  counter: 0,
  addItem: (item) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => ({
        items: [...state.items, item],
        counter: Math.max(state.counter, maxFitYByXSuffix([item])),
      }));
    },
  updateItem: (id, patch) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => {
        const items = state.items.map((item) => (item.id === id ? { ...item, ...patch } : item));
        return { items, counter: Math.max(state.counter, maxFitYByXSuffix(items)) };
      });
    },
  renameItem: (id, name) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => {
        const items = state.items.map((item) => (item.id === id ? { ...item, name } : item));
        return { items, counter: Math.max(state.counter, maxFitYByXSuffix(items)) };
      });
    },
  deleteItem: (id) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => ({
        items: state.items.filter((item) => item.id !== id),
      }));
    },
  deleteByDataset: (datasetId) =>
    {
      assertProjectMutable(useProjectStore.getState().readOnly);
      set((state) => ({
        items: state.items.filter((item) => item.sourceDatasetId !== datasetId),
      }));
    },
  loadFromProject: (items) => set({
    items: items.map((item) => normalizeLoadedItem(item)),
    counter: maxFitYByXSuffix(items),
  }),
  reset: () => set({ items: [], counter: 0 }),
  nextName: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const nextCounter = get().counter + 1;
    set({ counter: nextCounter });
    return `Fit Y by X ${nextCounter}`;
  },
}));