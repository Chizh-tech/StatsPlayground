import { create } from "zustand";

import type {
  DistributionAnalysisConfigV1,
  DerivedFormulaDocV1,
  DistributionDocV1,
  DistributionIssueV1,
  DistributionProgressV1,
  DistributionResultEnvelopeV1,
  DistributionRunFailureV1,
  DistributionRunStateV1,
  DistributionWorkspaceBootstrapV1,
  DistributionYReportPreferencesV1,
  LoadedDistributionDocV1,
} from "@/types/distribution";

export type DistributionConfigCommitResultV1 =
  | { ok: true; configRevision: number }
  | {
      ok: false;
      code: "distribution.config.revisionConflict" | "distribution.config.itemUnavailable";
    };

interface DistributionStore {
  items: DistributionDocV1[];
  derivedFormulas: DerivedFormulaDocV1[];
  issues: DistributionIssueV1[];
  selectedAnalysisId: string | null;
  bootstrap: DistributionWorkspaceBootstrapV1 | null;
  counter: number;
  /** Compatibility alias for the most recently started run. */
  runState: DistributionRunStateV1 | null;
  runStateByAnalysisId: Record<string, DistributionRunStateV1>;
  resultByAnalysisId: Record<string, DistributionResultEnvelopeV1>;
  failureByAnalysisId: Record<string, DistributionRunFailureV1>;
  loadFromProject: (
    items: DistributionDocV1[],
    derivedFormulas: DerivedFormulaDocV1[],
    issues: DistributionIssueV1[],
  ) => void;
  updateItem: (
    analysisId: string,
    patch: Partial<Pick<DistributionDocV1, "name" | "status">>,
  ) => void;
  createItem: (config: DistributionAnalysisConfigV1, name?: string) => LoadedDistributionDocV1;
  copyItem: (analysisId: string, name?: string) => LoadedDistributionDocV1 | null;
  renameItem: (analysisId: string, name: string) => void;
  commitConfig: (
    analysisId: string,
    baseConfigRevision: number,
    config: DistributionAnalysisConfigV1,
  ) => DistributionConfigCommitResultV1;
  updateReportPreferences: (
    analysisId: string,
    yColumnId: string,
    preferences: DistributionYReportPreferencesV1,
  ) => void;
  beginRun: (runState: DistributionRunStateV1) => boolean;
  acceptResult: (result: DistributionResultEnvelopeV1) => boolean;
  failRun: (failure: DistributionRunFailureV1) => boolean;
  deleteItem: (analysisId: string) => void;
  selectItem: (analysisId: string | null) => void;
  setBootstrap: (bootstrap: DistributionWorkspaceBootstrapV1 | null) => void;
  startRun: (runState: DistributionRunStateV1) => boolean;
  updateProgress: (progress: DistributionProgressV1) => void;
  cancelRun: (cancelToken: string) => void;
  reset: () => void;
}

const DISTRIBUTION_NAME_RE = /^Distribution (\d+)$/;

function maxDistributionSuffix(items: readonly DistributionDocV1[]): number {
  return items.reduce((maximum, item) => {
    const match = item.name.match(DISTRIBUTION_NAME_RE);
    return match ? Math.max(maximum, Number.parseInt(match[1], 10)) : maximum;
  }, 0);
}

function isLoadedDistributionDoc(
  item: DistributionDocV1 | undefined,
): item is LoadedDistributionDocV1 {
  return item?.loadStatus === "ready" || item?.loadStatus === "missingSource";
}

function runMatches(
  item: DistributionDocV1 | undefined,
  run: DistributionRunStateV1 | undefined,
  identity: Pick<
    DistributionRunStateV1,
    "analysisId" | "configRevision" | "runId" | "snapshotId"
  >,
): boolean {
  return isLoadedDistributionDoc(item) &&
    item.configRevision === identity.configRevision &&
    run?.analysisId === identity.analysisId &&
    run.configRevision === identity.configRevision &&
    run.runId === identity.runId &&
    run.snapshotId === identity.snapshotId &&
    run.status === "running";
}

export const useDistributionStore = create<DistributionStore>((set, get) => ({
  items: [],
  derivedFormulas: [],
  issues: [],
  selectedAnalysisId: null,
  bootstrap: null,
  counter: 0,
  runState: null,
  runStateByAnalysisId: {},
  resultByAnalysisId: {},
  failureByAnalysisId: {},
  loadFromProject: (items, derivedFormulas, issues) =>
    set({
      items,
      derivedFormulas,
      issues,
      selectedAnalysisId: null,
      counter: maxDistributionSuffix(items),
      runState: null,
      runStateByAnalysisId: {},
      resultByAnalysisId: {},
      failureByAnalysisId: {},
    }),
  updateItem: (analysisId, patch) =>
    set((state) => ({
      items: state.items.map((item) =>
        item.analysisId === analysisId ? { ...item, ...patch } : item,
      ),
    })),
  createItem: (config, requestedName) => {
    const nextCounter = get().counter + 1;
    const name = requestedName?.trim() || `Distribution ${nextCounter}`;
    const item: LoadedDistributionDocV1 = {
      schemaVersion: "1",
      analysisId: globalThis.crypto.randomUUID(),
      name,
      sourceDatasetId: config.sourceDatasetId,
      status: "ready",
      loadStatus: "ready",
      configRevision: 1,
      currentConfig: structuredClone(config),
    };
    set((state) => ({
      items: [...state.items, item],
      selectedAnalysisId: item.analysisId,
      counter: requestedName
        ? Math.max(state.counter, maxDistributionSuffix([item]))
        : nextCounter,
    }));
    return item;
  },
  copyItem: (analysisId, requestedName) => {
    const source = get().items.find((item) => item.analysisId === analysisId);
    if (!isLoadedDistributionDoc(source)) {
      return null;
    }
    const nextCounter = get().counter + 1;
    const name = requestedName?.trim() || `Distribution ${nextCounter}`;
    const item: LoadedDistributionDocV1 = {
      ...source,
      analysisId: globalThis.crypto.randomUUID(),
      name,
      configRevision: 1,
      currentConfig: structuredClone(source.currentConfig),
    };
    set((state) => ({
      items: [...state.items, item],
      selectedAnalysisId: item.analysisId,
      counter: requestedName
        ? Math.max(state.counter, maxDistributionSuffix([item]))
        : nextCounter,
    }));
    return item;
  },
  renameItem: (analysisId, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    set((state) => {
      const items = state.items.map((item) =>
        item.analysisId === analysisId ? { ...item, name: trimmed } : item,
      );
      return {
        items,
        counter: Math.max(state.counter, maxDistributionSuffix(items)),
      };
    });
  },
  commitConfig: (analysisId, baseConfigRevision, config) => {
    const item = get().items.find((entry) => entry.analysisId === analysisId);
    if (!isLoadedDistributionDoc(item)) {
      return { ok: false, code: "distribution.config.itemUnavailable" };
    }
    if (item.configRevision !== baseConfigRevision) {
      return { ok: false, code: "distribution.config.revisionConflict" };
    }
    const configRevision = baseConfigRevision + 1;
    set((state) => {
      const currentRun = state.runStateByAnalysisId[analysisId];
      const runStateByAnalysisId = { ...state.runStateByAnalysisId };
      if (currentRun?.status === "running") {
        runStateByAnalysisId[analysisId] = { ...currentRun, status: "stale" };
      }
      return {
        items: state.items.map((entry) => {
          if (entry.analysisId !== analysisId || !isLoadedDistributionDoc(entry)) return entry;
          return {
            ...entry,
            sourceDatasetId: config.sourceDatasetId,
            status: "ready",
            loadStatus: "ready",
            currentConfig: structuredClone(config),
            configRevision,
          };
        }),
        runStateByAnalysisId,
        runState: state.runState?.analysisId === analysisId && state.runState.status === "running"
          ? { ...state.runState, status: "stale" }
          : state.runState,
      };
    });
    return { ok: true, configRevision };
  },
  updateReportPreferences: (analysisId, yColumnId, preferences) =>
    set((state) => ({
      items: state.items.map((item) => {
        if (item.analysisId !== analysisId || !isLoadedDistributionDoc(item)) return item;
        return {
          ...item,
          currentConfig: {
            ...item.currentConfig,
            reportPreferences: {
              ...item.currentConfig.reportPreferences,
              [yColumnId]: structuredClone(preferences),
            },
          },
        };
      }),
    })),
  beginRun: (runState) => {
    const item = get().items.find((entry) => entry.analysisId === runState.analysisId);
    if (!isLoadedDistributionDoc(item) || item.configRevision !== runState.configRevision) {
      return false;
    }
    set((state) => {
      const failureByAnalysisId = { ...state.failureByAnalysisId };
      delete failureByAnalysisId[runState.analysisId];
      return {
        runState,
        runStateByAnalysisId: {
          ...state.runStateByAnalysisId,
          [runState.analysisId]: runState,
        },
        failureByAnalysisId,
      };
    });
    return true;
  },
  acceptResult: (result) => {
    const state = get();
    const item = state.items.find((entry) => entry.analysisId === result.analysisId);
    const run = state.runStateByAnalysisId[result.analysisId];
    if (!runMatches(item, run, result)) return false;
    const completed = { ...run, status: "completed" as const };
    set((current) => {
      const failureByAnalysisId = { ...current.failureByAnalysisId };
      delete failureByAnalysisId[result.analysisId];
      return {
        runState: current.runState?.analysisId === result.analysisId ? completed : current.runState,
        runStateByAnalysisId: {
          ...current.runStateByAnalysisId,
          [result.analysisId]: completed,
        },
        resultByAnalysisId: {
          ...current.resultByAnalysisId,
          [result.analysisId]: result,
        },
        failureByAnalysisId,
      };
    });
    return true;
  },
  failRun: (failure) => {
    const state = get();
    const item = state.items.find((entry) => entry.analysisId === failure.analysisId);
    const run = state.runStateByAnalysisId[failure.analysisId];
    if (!runMatches(item, run, failure)) return false;
    const failed = { ...run, status: "failed" as const };
    set((current) => ({
      runState: current.runState?.analysisId === failure.analysisId ? failed : current.runState,
      runStateByAnalysisId: {
        ...current.runStateByAnalysisId,
        [failure.analysisId]: failed,
      },
      failureByAnalysisId: {
        ...current.failureByAnalysisId,
        [failure.analysisId]: failure,
      },
    }));
    return true;
  },
  deleteItem: (analysisId) =>
    set((state) => {
      const runStateByAnalysisId = { ...state.runStateByAnalysisId };
      const resultByAnalysisId = { ...state.resultByAnalysisId };
      const failureByAnalysisId = { ...state.failureByAnalysisId };
      delete runStateByAnalysisId[analysisId];
      delete resultByAnalysisId[analysisId];
      delete failureByAnalysisId[analysisId];
      return {
        items: state.items.filter((item) => item.analysisId !== analysisId),
        derivedFormulas: state.derivedFormulas.filter(
          (formula) => formula.analysisId !== analysisId,
        ),
        issues: state.issues.filter((issue) => issue.analysisId !== analysisId),
        selectedAnalysisId: state.selectedAnalysisId === analysisId
          ? null
          : state.selectedAnalysisId,
        runState: state.runState?.analysisId === analysisId ? null : state.runState,
        runStateByAnalysisId,
        resultByAnalysisId,
        failureByAnalysisId,
      };
    }),
  selectItem: (selectedAnalysisId) => set({ selectedAnalysisId }),
  setBootstrap: (bootstrap) => set({ bootstrap }),
  startRun: (runState) => get().beginRun(runState),
  updateProgress: (progress) =>
    set((state) => {
      const run = state.runStateByAnalysisId[progress.analysisId];
      const item = state.items.find((candidate) => candidate.analysisId === progress.analysisId);
      if (!runMatches(item, run, progress)) return state;
      const previous = run.progress;
      if (previous && (progress.current < previous.current || progress.percent < previous.percent)) {
        return state;
      }
      const updated = { ...run, progress };
      return {
        runState: runMatches(item, state.runState ?? undefined, progress)
          ? updated
          : state.runState,
        runStateByAnalysisId: {
          ...state.runStateByAnalysisId,
          [progress.analysisId]: updated,
        },
      };
    }),
  cancelRun: (cancelToken) =>
    set((state) => {
      const entry = Object.entries(state.runStateByAnalysisId)
        .find(([, run]) => run.cancelToken === cancelToken);
      if (!entry) return state;
      const [analysisId, run] = entry;
      const cancelled = { ...run, status: "cancelled" as const };
      return {
        runState: state.runState?.cancelToken === cancelToken ? cancelled : state.runState,
        runStateByAnalysisId: {
          ...state.runStateByAnalysisId,
          [analysisId]: cancelled,
        },
      };
    }),
  reset: () =>
    set({
      items: [],
      derivedFormulas: [],
      issues: [],
      selectedAnalysisId: null,
      bootstrap: null,
      counter: 0,
      runState: null,
      runStateByAnalysisId: {},
      resultByAnalysisId: {},
      failureByAnalysisId: {},
    }),
}));