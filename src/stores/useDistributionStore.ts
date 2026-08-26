import { create } from "zustand";

import type {
  DerivedFormulaDocV1,
  DistributionDocV1,
  DistributionIssueV1,
  DistributionProgressV1,
  DistributionRunStateV1,
  DistributionWorkspaceBootstrapV1,
} from "@/types/distribution";

interface DistributionStore {
  items: DistributionDocV1[];
  derivedFormulas: DerivedFormulaDocV1[];
  issues: DistributionIssueV1[];
  selectedAnalysisId: string | null;
  bootstrap: DistributionWorkspaceBootstrapV1 | null;
  runState: DistributionRunStateV1 | null;
  loadFromProject: (
    items: DistributionDocV1[],
    derivedFormulas: DerivedFormulaDocV1[],
    issues: DistributionIssueV1[],
  ) => void;
  updateItem: (analysisId: string, patch: Partial<DistributionDocV1>) => void;
  deleteItem: (analysisId: string) => void;
  selectItem: (analysisId: string | null) => void;
  setBootstrap: (bootstrap: DistributionWorkspaceBootstrapV1 | null) => void;
  startRun: (runState: DistributionRunStateV1) => void;
  updateProgress: (progress: DistributionProgressV1) => void;
  cancelRun: (cancelToken: string) => void;
  reset: () => void;
}

export const useDistributionStore = create<DistributionStore>((set) => ({
  items: [],
  derivedFormulas: [],
  issues: [],
  selectedAnalysisId: null,
  bootstrap: null,
  runState: null,
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
  startRun: (runState) => set({ runState }),
  updateProgress: (progress) =>
    set((state) => {
      if (!state.runState || state.runState.runId !== progress.runId) return state;
      const previous = state.runState.progress;
      if (previous && (progress.current < previous.current || progress.percent < previous.percent)) {
        return state;
      }
      return { runState: { ...state.runState, progress } };
    }),
  cancelRun: (cancelToken) =>
    set((state) => {
      if (!state.runState || state.runState.cancelToken !== cancelToken) return state;
      return { runState: { ...state.runState, status: "cancelled" } };
    }),
  reset: () =>
    set({
      items: [],
      derivedFormulas: [],
      issues: [],
      selectedAnalysisId: null,
      bootstrap: null,
      runState: null,
    }),
}));