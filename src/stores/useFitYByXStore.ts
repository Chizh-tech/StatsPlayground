import { create } from "zustand";

import { createFitYByXItem } from "@/components/fitYByX/fitYByXConfig";
import { createEmbeddedGraphItem } from "@/components/graphBuilder/graphBuilderMode";
import { useProjectStore } from "@/stores/useProjectStore";
import type { EmbeddedGraphConfig } from "@/types/graphBuilder";
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isLoadableEmbeddedGraphConfig(value: unknown): value is EmbeddedGraphConfig {
  if (!isObject(value)) return false;
  if (value.mode !== "2d" && value.mode !== "3d" && value.mode !== "multivariate") return false;
  if (!isObject(value.modeStates)) return false;
  return isObject(value.modeStates.twoD)
    && isObject(value.modeStates.threeD)
    && isObject(value.modeStates.multivariate);
}

function extractEmbeddedGraphConfig(item: ReturnType<typeof createEmbeddedGraphItem>): EmbeddedGraphConfig {
  return {
    mode: item.mode,
    modeStates: item.modeStates,
    filters: item.filters,
    sampling: item.sampling,
  };
}

function normalizeLoadedItem(item: FitYByXItem): FitYByXItem {
  const base = createFitYByXItem({
    id: item.id,
    name: item.name,
    sourceDatasetId: item.sourceDatasetId,
    response: item.response,
    factor: item.factor,
    createdAt: item.createdAt,
  });

  if (!isLoadableEmbeddedGraphConfig(item.graph)) {
    return base;
  }

  return {
    ...base,
    graph: extractEmbeddedGraphConfig(createEmbeddedGraphItem({
      id: `fit-y-by-x-graph:${base.id}`,
      name: base.name,
      sourceDatasetId: base.sourceDatasetId,
      config: item.graph,
      createdAt: base.createdAt,
    })),
  };
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