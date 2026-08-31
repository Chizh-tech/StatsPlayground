import { useEffect, useState } from "react";

import type { FitYByXItem, FitYByXRequest, FitYByXResult } from "@/types/fitYByX";

const FIT_Y_BY_X_CONFIDENCE_LEVEL = 0.95;

export interface FitYByXReportDependencies {
  getDatasetGeneration: (datasetId: string) => Promise<number>;
  run: (request: FitYByXRequest) => Promise<FitYByXResult>;
}

export interface FitYByXIdleReportState {
  status: "idle";
}

export interface FitYByXLoadingReportState {
  status: "loading";
  itemId: string;
  datasetId: string;
  request: FitYByXRequest | null;
}

export interface FitYByXSuccessReportState {
  status: "success";
  itemId: string;
  datasetId: string;
  request: FitYByXRequest;
  result: FitYByXResult;
}

export interface FitYByXErrorReportState {
  status: "error";
  itemId: string;
  datasetId: string;
  request: FitYByXRequest | null;
  error: string;
}

export type FitYByXReportGenerationSignal = string | number | boolean | null | undefined;

export type FitYByXReportState =
  | FitYByXIdleReportState
  | FitYByXLoadingReportState
  | FitYByXSuccessReportState
  | FitYByXErrorReportState;

export const FIT_Y_BY_X_IDLE_REPORT_STATE: FitYByXReportState = {
  status: "idle",
};

interface FitYByXReportControllerOptions extends FitYByXReportDependencies {
  onStateChange?: (state: FitYByXReportState) => void;
}

interface ActiveFitYByXRequest {
  token: number;
  itemId: string;
  datasetId: string;
  generation: number | null;
}

export interface FitYByXReportController {
  getState: () => FitYByXReportState;
  load: (item: FitYByXItem) => Promise<void>;
  cancel: () => void;
  dispose: () => void;
}

export function createFitYByXRequest(item: FitYByXItem, generation: number): FitYByXRequest {
  return {
    datasetId: item.sourceDatasetId,
    generation,
    responseColumn: item.response.name,
    factorColumn: item.factor.name,
    personality: item.personality,
    confidenceLevel: FIT_Y_BY_X_CONFIDENCE_LEVEL,
  };
}

export async function loadFitYByXReport(
  item: FitYByXItem,
  dependencies: FitYByXReportDependencies,
): Promise<{ request: FitYByXRequest; result: FitYByXResult }> {
  const generation = await dependencies.getDatasetGeneration(item.sourceDatasetId);
  const request = createFitYByXRequest(item, generation);
  const result = await dependencies.run(request);
  return { request, result };
}

export function createFitYByXReportController(
  options: FitYByXReportControllerOptions,
): FitYByXReportController {
  let state: FitYByXReportState = FIT_Y_BY_X_IDLE_REPORT_STATE;
  let disposed = false;
  let nextToken = 0;
  let active: ActiveFitYByXRequest | null = null;

  const emit = (nextState: FitYByXReportState) => {
    state = nextState;
    options.onStateChange?.(nextState);
  };

  const isActive = (candidate: ActiveFitYByXRequest): boolean => {
    if (disposed || active == null) {
      return false;
    }

    return active.token === candidate.token
      && active.itemId === candidate.itemId
      && active.datasetId === candidate.datasetId
      && active.generation === candidate.generation;
  };

  const start = (item: FitYByXItem): ActiveFitYByXRequest => {
    const current: ActiveFitYByXRequest = {
      token: nextToken + 1,
      itemId: item.id,
      datasetId: item.sourceDatasetId,
      generation: null,
    };
    nextToken = current.token;
    active = current;
    emit({
      status: "loading",
      itemId: current.itemId,
      datasetId: current.datasetId,
      request: null,
    });
    return current;
  };

  const clearActive = () => {
    active = null;
  };

  return {
    getState: () => state,
    cancel: () => {
      if (disposed) {
        return;
      }

      nextToken += 1;
      clearActive();
      emit(FIT_Y_BY_X_IDLE_REPORT_STATE);
    },
    dispose: () => {
      disposed = true;
      nextToken += 1;
      clearActive();
    },
    load: async (item) => {
      const pending = start(item);

      try {
        const generation = await options.getDatasetGeneration(pending.datasetId);
        if (!isActive(pending)) {
          return;
        }

        const request = createFitYByXRequest(item, generation);
        const running: ActiveFitYByXRequest = {
          ...pending,
          generation,
        };
        active = running;

        emit({
          status: "loading",
          itemId: running.itemId,
          datasetId: running.datasetId,
          request,
        });

        const result = await options.run(request);
        if (!isActive(running)) {
          return;
        }

        emit({
          status: "success",
          itemId: running.itemId,
          datasetId: running.datasetId,
          request,
          result,
        });
      } catch (error) {
        const current = active;
        if (current == null || current.token !== pending.token || current.itemId !== pending.itemId || current.datasetId !== pending.datasetId) {
          return;
        }

        const request = current.generation == null
          ? null
          : createFitYByXRequest(item, current.generation);

        emit({
          status: "error",
          itemId: pending.itemId,
          datasetId: pending.datasetId,
          request,
          error: normalizeFitYByXReportError(error),
        });
      }
    },
  };
}

export function normalizeFitYByXReportError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "object" && error !== null) {
    const message = Reflect.get(error, "message");
    if (typeof message === "string" && message.trim().length > 0) {
      return message;
    }
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "Failed to load Fit Y by X report.";
}

async function resolveFitYByXReportDependencies(
  overrides: Partial<FitYByXReportDependencies> | undefined,
): Promise<FitYByXReportDependencies> {
  if (overrides?.getDatasetGeneration && overrides.run) {
    return {
      getDatasetGeneration: overrides.getDatasetGeneration,
      run: overrides.run,
    };
  }

  const [{ dataService }, { fitYByXService }] = await Promise.all([
    import("../../services/dataService"),
    import("../../services/fitYByXService"),
  ]);

  return {
    getDatasetGeneration: overrides?.getDatasetGeneration ?? dataService.getDatasetGeneration,
    run: overrides?.run ?? fitYByXService.run,
  };
}

export function useFitYByXReport(
  item: FitYByXItem | null | undefined,
  generationSignal: FitYByXReportGenerationSignal,
  dependencies?: Partial<FitYByXReportDependencies>,
): FitYByXReportState {
  const [state, setState] = useState<FitYByXReportState>(FIT_Y_BY_X_IDLE_REPORT_STATE);
  const getDatasetGeneration = dependencies?.getDatasetGeneration;
  const run = dependencies?.run;

  useEffect(() => {
    if (item == null) {
      setState(FIT_Y_BY_X_IDLE_REPORT_STATE);
      return undefined;
    }

    let mounted = true;
    let controller: FitYByXReportController | null = null;

    void (async () => {
      try {
        const resolved = await resolveFitYByXReportDependencies({
          getDatasetGeneration,
          run,
        });
        if (!mounted) {
          return;
        }

        controller = createFitYByXReportController({
          ...resolved,
          onStateChange: setState,
        });
        await controller.load(item);
      } catch (error) {
        if (!mounted) {
          return;
        }

        setState({
          status: "error",
          itemId: item.id,
          datasetId: item.sourceDatasetId,
          request: null,
          error: normalizeFitYByXReportError(error),
        });
      }
    })();

    return () => {
      mounted = false;
      controller?.dispose();
    };
  }, [
    getDatasetGeneration,
    generationSignal,
    item,
    run,
  ]);

  return state;
}