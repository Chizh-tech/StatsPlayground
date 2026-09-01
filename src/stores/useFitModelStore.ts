import { create } from "zustand";

import {
  canonicalizeFitModelTerms,
  FitModelValidationError,
  validateFitModelDefinition,
} from "@/components/fitModel/fitModelConfig";
import type { FieldRef } from "@/graphCore";
import { useProjectStore } from "@/stores/useProjectStore";
import type { FitModelItem, FitModelTerm } from "@/types/fitModel";
import { assertProjectMutable } from "@/utils/saveReadOnly";

interface FitModelStore {
  items: FitModelItem[];
  counter: number;
  migrationWarnings: string[];
  addItem: (item: FitModelItem) => void;
  updateItem: (id: string, patch: Partial<FitModelItem>) => void;
  renameItem: (id: string, name: string) => void;
  deleteItem: (id: string) => void;
  deleteByDataset: (datasetId: string) => void;
  loadFromProject: (items: unknown[]) => void;
  reset: () => void;
  nextName: () => string;
}

const FIT_MODEL_NAME_RE = /^Fit Model (\d+)$/;

function maxFitModelSuffix(items: readonly FitModelItem[]): number {
  return items.reduce((maxValue, item) => {
    const match = item.name.match(FIT_MODEL_NAME_RE);
    if (!match) {
      return maxValue;
    }
    return Math.max(maxValue, Number.parseInt(match[1], 10));
  }, 0);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function cloneResponse(value: FieldRef): FieldRef {
  return { name: value.name, type: value.type };
}

function cloneTerms(terms: readonly FitModelTerm[]): FitModelTerm[] {
  return terms.map((term) => ({ kind: term.kind, columnNames: [...term.columnNames] }));
}

function termKey(term: FitModelTerm): string {
  if (term.kind === "main") {
    return `main:${term.columnNames[0] ?? ""}`;
  }
  return `interaction:${(term.columnNames[0] ?? "")}*${(term.columnNames[1] ?? "")}`;
}

function sanitizeItem(item: FitModelItem): FitModelItem {
  const validation = validateFitModelDefinition({
    response: item.response,
    terms: item.terms,
  });
  if (!validation.ok) {
    throw new FitModelValidationError(validation);
  }

  return {
    id: item.id,
    name: item.name,
    sourceDatasetId: item.sourceDatasetId,
    response: cloneResponse(item.response),
    terms: cloneTerms(canonicalizeFitModelTerms(item.terms)),
    centeringMethod: item.centeringMethod,
    createdAt: item.createdAt,
  };
}

function parseTerm(value: unknown): FitModelTerm | null {
  if (!isObject(value)) return null;
  const kind = value.kind;
  const columnNames = value.columnNames;
  if ((kind !== "main" && kind !== "interaction") || !Array.isArray(columnNames)) {
    return null;
  }
  if (!columnNames.every((entry) => typeof entry === "string")) {
    return null;
  }
  return {
    kind,
    columnNames: [...columnNames],
  };
}

function normalizeLoadedFitModel(value: unknown): {
  item: FitModelItem | null;
  warnings: string[];
} {
  if (!isObject(value)) return { item: null, warnings: [] };

  const id = value.id;
  const name = value.name;
  const sourceDatasetId = value.sourceDatasetId;
  const response = value.response;
  const terms = value.terms;
  const centeringMethod = value.centeringMethod;
  const createdAt = value.createdAt;

  if (
    typeof id !== "string"
    || typeof name !== "string"
    || typeof sourceDatasetId !== "string"
    || !isObject(response)
    || typeof response.name !== "string"
    || (response.type !== "continuous" && response.type !== "ordinal" && response.type !== "nominal")
    || !Array.isArray(terms)
    || (centeringMethod !== "none" && centeringMethod !== "mean")
    || typeof createdAt !== "string"
  ) {
    return { item: null, warnings: [] };
  }

  const parsedTerms: FitModelTerm[] = [];
  for (const term of terms) {
    const parsed = parseTerm(term);
    if (!parsed) {
      return { item: null, warnings: [] };
    }
    parsedTerms.push(parsed);
  }

  const canonicalTerms = canonicalizeFitModelTerms(parsedTerms);
  const dedupedTerms: FitModelTerm[] = [];
  const seen = new Set<string>();
  const warnings: string[] = [];
  for (const term of canonicalTerms) {
    const key = termKey(term);
    if (seen.has(key)) {
      warnings.push(`Dropped duplicate Fit Model term ${key} while loading ${id}.`);
      continue;
    }
    seen.add(key);
    dedupedTerms.push(term);
  }

  const candidate: FitModelItem = {
    id,
    name,
    sourceDatasetId,
    response: { name: response.name, type: response.type },
    terms: dedupedTerms,
    centeringMethod,
    createdAt,
  };

  try {
    return { item: sanitizeItem(candidate), warnings };
  } catch (error) {
    if (error instanceof FitModelValidationError) {
      return { item: null, warnings: [] };
    }
    throw error;
  }
}

function nextCounterValue(items: readonly FitModelItem[]): number {
  return Math.max(1, maxFitModelSuffix(items) + 1);
}

export const useFitModelStore = create<FitModelStore>((set, get) => ({
  items: [],
  counter: 1,
  migrationWarnings: [],
  addItem: (item) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const normalized = sanitizeItem(item);
    set((state) => ({
      items: [...state.items, normalized],
      counter: Math.max(state.counter, nextCounterValue([normalized])),
    }));
  },
  updateItem: (id, patch) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => {
      const items = state.items.map((item) => {
        if (item.id !== id) {
          return item;
        }

        const next: FitModelItem = {
          id: typeof patch.id === "string" ? patch.id : item.id,
          name: typeof patch.name === "string" ? patch.name : item.name,
          sourceDatasetId: typeof patch.sourceDatasetId === "string" ? patch.sourceDatasetId : item.sourceDatasetId,
          response: patch.response ? cloneResponse(patch.response) : cloneResponse(item.response),
          terms: patch.terms ? cloneTerms(canonicalizeFitModelTerms(patch.terms)) : cloneTerms(item.terms),
          centeringMethod: patch.centeringMethod ?? item.centeringMethod,
          createdAt: typeof patch.createdAt === "string" ? patch.createdAt : item.createdAt,
        };

        return sanitizeItem(next);
      });

      return {
        items,
        counter: Math.max(state.counter, nextCounterValue(items)),
      };
    });
  },
  renameItem: (id, name) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => {
      const items = state.items.map((item) => {
        if (item.id !== id) {
          return item;
        }
        return sanitizeItem({ ...item, name: trimmed });
      });
      return {
        items,
        counter: Math.max(state.counter, nextCounterValue(items)),
      };
    });
  },
  deleteItem: (id) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({ items: state.items.filter((item) => item.id !== id) }));
  },
  deleteByDataset: (datasetId) => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    set((state) => ({ items: state.items.filter((item) => item.sourceDatasetId !== datasetId) }));
  },
  loadFromProject: (items) => set(() => {
    const normalized: FitModelItem[] = [];
    const migrationWarnings: string[] = [];
    for (const value of items) {
      const next = normalizeLoadedFitModel(value);
      if (!next.item) {
        continue;
      }
      normalized.push(next.item);
      migrationWarnings.push(...next.warnings);
    }
    return {
      items: normalized,
      counter: nextCounterValue(normalized),
      migrationWarnings,
    };
  }),
  reset: () => set({ items: [], counter: 1, migrationWarnings: [] }),
  nextName: () => {
    assertProjectMutable(useProjectStore.getState().readOnly);
    const nextCounter = get().counter;
    set({ counter: nextCounter + 1 });
    return `Fit Model ${nextCounter}`;
  },
}));