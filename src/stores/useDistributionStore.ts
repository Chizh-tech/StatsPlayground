import { create } from "zustand";

import type {
  DerivedFormulaDocV1,
  DistributionDocV1,
  DistributionIssueV1,
  DistributionWorkspaceBootstrapV1,
} from "@/types/distribution";

interface DistributionStore {
  items: DistributionDocV1[];
  derivedFormulas: DerivedFormulaDocV1[];
  issues: DistributionIssueV1[];
  selectedAnalysisId: string | null;
  bootstrap: DistributionWorkspaceBootstrapV1 | null;
  loadFromProject: (
    items: DistributionDocV1[],
    derivedFormulas: DerivedFormulaDocV1[],
    issues: DistributionIssueV1[],
  ) => void;
  updateItem: (analysisId: string, patch: Partial<DistributionDocV1>) => void;
  deleteItem: (analysisId: string) => void;
  selectItem: (analysisId: string | null) => void;
  setBootstrap: (bootstrap: DistributionWorkspaceBootstrapV1 | null) => void;
  reset: () => void;
}

export const useDistributionStore = create<DistributionStore>((set) => ({
  items: [],
  derivedFormulas: [],
  issues: [],
  selectedAnalysisId: null,
  bootstrap: null,
  loadFromProject: (items, derivedFormulas, issues) =>
    set({ items, derivedFormulas, issues, selectedAnalysisId: null }),
  updateItem: (analysisId, patch) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.analysisId === analysisId ? { ...item, ...patch } : item,
      ),
    })),
  deleteItem: (analysisId) =>
    set((state) => ({
      items: state.items.filter((item) => item.analysisId !== analysisId),
      derivedFormulas: state.derivedFormulas.filter(
        (formula) => formula.analysisId !== analysisId,
      ),
      issues: state.issues.filter((issue) => issue.analysisId !== analysisId),
      selectedAnalysisId:
        state.selectedAnalysisId === analysisId ? null : state.selectedAnalysisId,
    })),
  selectItem: (selectedAnalysisId) => set({ selectedAnalysisId }),
  setBootstrap: (bootstrap) => set({ bootstrap }),
  reset: () =>
    set({
      items: [],
      derivedFormulas: [],
      issues: [],
      selectedAnalysisId: null,
      bootstrap: null,
    }),
}));