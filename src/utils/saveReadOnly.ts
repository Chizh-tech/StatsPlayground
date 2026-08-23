import type { SaveProgress } from "@/services/projectService";

export interface SaveLifecycleState {
  dirty: boolean;
  saving: boolean;
  readOnly: boolean;
  saveProgress: SaveProgress | null;
}

export function assertProjectMutable(readOnly: boolean): void {
  if (readOnly) {
    throw new Error("Project is read-only while save is in progress.");
  }
}

export function beginSaveState(state: SaveLifecycleState): SaveLifecycleState {
  if (state.saving) {
    throw new Error("Save is already in progress.");
  }
  return {
    ...state,
    saving: true,
    readOnly: true,
    saveProgress: null,
  };
}

export function completeSaveState(state: SaveLifecycleState): SaveLifecycleState {
  return {
    ...state,
    dirty: false,
    saving: false,
    readOnly: false,
    saveProgress: null,
  };
}

export function failSaveState(state: SaveLifecycleState): SaveLifecycleState {
  return {
    ...state,
    dirty: true,
    saving: false,
    readOnly: false,
    saveProgress: null,
  };
}

function scoreProgress(progress: SaveProgress): number {
  if (typeof progress.overallProgress === "number" && Number.isFinite(progress.overallProgress)) {
    return progress.overallProgress;
  }
  const tableTotal = progress.tableTotal > 0 ? progress.tableTotal : 1;
  const tablePart = Math.max(0, Math.min(1, progress.tableIndex / tableTotal));
  const rowPart = progress.rowsTotal > 0
    ? Math.max(0, Math.min(1, progress.rowsDone / progress.rowsTotal)) / tableTotal
    : 0;
  return tablePart + rowPart;
}

export function replaceSaveProgress(
  current: SaveProgress | null,
  incoming: SaveProgress,
): SaveProgress {
  if (!current) return incoming;
  const currentScore = scoreProgress(current);
  const incomingScore = scoreProgress(incoming);
  return incomingScore >= currentScore ? incoming : current;
}