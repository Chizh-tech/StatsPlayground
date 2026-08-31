import assert from "node:assert/strict";

import type {
  FitYByXBivariateResult,
  FitYByXItem,
  FitYByXNotComputableResult,
  FitYByXOnewayResult,
  FitYByXRequest,
  FitYByXResult,
} from "../src/types/fitYByX.ts";
import {
  createFitYByXReportController,
  type FitYByXReportState,
} from "../src/components/fitYByX/useFitYByXReport.ts";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
};

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  return Promise.resolve();
}

function createItem(overrides: Partial<FitYByXItem> = {}): FitYByXItem {
  return {
    id: "fit-1",
    name: "Fit Y by X",
    sourceDatasetId: "dataset-1",
    response: { name: "response", type: "continuous" },
    factor: { name: "factor", type: "continuous" },
    personality: "bivariate",
    graph: {
      mode: "2d",
      modeStates: {
        twoD: {
          encoding: {},
          multiX: [],
          multiY: [],
          elements: [],
        },
        threeD: {
          encoding: {},
          elements: [],
        },
        multivariate: {
          columns: [],
          elements: [],
        },
      },
      filters: [],
      sampling: { mode: "full" },
    },
    createdAt: "2026-08-31T00:00:00.000Z",
    ...overrides,
  };
}

function makeBivariateResult(overrides: Partial<FitYByXBivariateResult> = {}): FitYByXBivariateResult {
  return {
    kind: "bivariate",
    usedRows: 4,
    excludedRows: 1,
    confidenceLevel: 0.95,
    intercept: 1,
    slope: 2,
    summaryOfFit: {
      rSquared: 0.75,
      adjustedRSquared: 0.7,
      rootMeanSquareError: 1.5,
      meanOfResponse: 8,
      observationCount: 4,
    },
    lackOfFit: {
      state: "notIdentifiable",
    },
    anova: [],
    parameterEstimates: [],
    ...overrides,
  };
}

function makeOnewayResult(overrides: Partial<FitYByXOnewayResult> = {}): FitYByXOnewayResult {
  return {
    kind: "oneway",
    usedRows: 5,
    excludedRows: 0,
    confidenceLevel: 0.95,
    groupSummaries: [],
    anova: [],
    effectSizes: {
      etaSquared: 0.4,
      omegaSquared: null,
    },
    ...overrides,
  };
}

function makeNotComputableResult(overrides: Partial<FitYByXNotComputableResult> = {}): FitYByXNotComputableResult {
  return {
    kind: "notComputable",
    personality: "oneway",
    reason: "insufficientGroups",
    usedRows: 2,
    excludedRows: 3,
    confidenceLevel: 0.95,
    ...overrides,
  };
}

function expectLoading(state: FitYByXReportState, request: FitYByXRequest): void {
  assert.equal(state.status, "loading");
  assert.deepEqual(state.request, request);
}

function expectSuccess(state: FitYByXReportState, request: FitYByXRequest, result: FitYByXResult): void {
  assert.equal(state.status, "success");
  assert.deepEqual(state.request, request);
  assert.deepEqual(state.result, result);
}

function expectError(state: FitYByXReportState, request: FitYByXRequest, message: string): void {
  assert.equal(state.status, "error");
  assert.deepEqual(state.request, request);
  assert.equal(state.error, message);
}

async function testLaterRequestWinsWhenEarlierCompletionArrivesLast(): Promise<void> {
  const item = createItem();
  const generationA = createDeferred<number>();
  const generationB = createDeferred<number>();
  const runA = createDeferred<FitYByXResult>();
  const runB = createDeferred<FitYByXResult>();
  const states: FitYByXReportState[] = [];
  const requests: FitYByXRequest[] = [];
  let loadCount = 0;

  const controller = createFitYByXReportController({
    onStateChange: (state) => {
      states.push(state);
    },
    getDatasetGeneration: async () => {
      loadCount += 1;
      return loadCount === 1 ? generationA.promise : generationB.promise;
    },
    run: async (request) => {
      requests.push(request);
      return requests.length === 1 ? runA.promise : runB.promise;
    },
  });

  const firstLoad = controller.load(item);

  assert.equal(states[0]?.status, "loading");

  generationA.resolve(7);
  await flushMicrotasks();

  assert.equal(requests.length, 1);
  const firstRequest = requests[0]!;
  assert.deepEqual(firstRequest, {
    datasetId: "dataset-1",
    generation: 7,
    responseColumn: "response",
    factorColumn: "factor",
    personality: "bivariate",
    confidenceLevel: 0.95,
  });
  expectLoading(states.at(-1)!, firstRequest);

  const secondLoad = controller.load(item);
  assert.equal(states.at(-1)?.status, "loading");

  generationB.resolve(8);
  await flushMicrotasks();

  assert.equal(requests.length, 2);
  const secondRequest = requests[1]!;
  assert.deepEqual(secondRequest, {
    datasetId: "dataset-1",
    generation: 8,
    responseColumn: "response",
    factorColumn: "factor",
    personality: "bivariate",
    confidenceLevel: 0.95,
  });
  expectLoading(states.at(-1)!, secondRequest);

  const latest = makeBivariateResult({ slope: 5, intercept: -2 });
  runB.resolve(latest);
  await secondLoad;
  expectSuccess(states.at(-1)!, secondRequest, latest);

  const stale = makeBivariateResult({ slope: 1, intercept: 99 });
  runA.resolve(stale);
  await firstLoad;
  expectSuccess(states.at(-1)!, secondRequest, latest);
}

async function testNormalizesErrorsAndIgnoresCancelAndUnmount(): Promise<void> {
  const item = createItem({ personality: "oneway", factor: { name: "group", type: "nominal" } });
  const generation = createDeferred<number>();
  const runResult = createDeferred<FitYByXResult>();
  const states: FitYByXReportState[] = [];
  const controller = createFitYByXReportController({
    onStateChange: (state) => {
      states.push(state);
    },
    getDatasetGeneration: () => generation.promise,
    run: () => runResult.promise,
  });

  const firstLoad = controller.load(item);
  generation.resolve(9);
  await flushMicrotasks();
  const firstRequest = states.at(-1)?.status === "loading" ? states.at(-1)!.request : undefined;
  assert.ok(firstRequest);

  runResult.reject({ message: "backend failed" });
  await firstLoad;
  expectError(states.at(-1)!, firstRequest, "backend failed");

  const cancelGeneration = createDeferred<number>();
  const cancelRun = createDeferred<FitYByXResult>();
  const canceledStates: FitYByXReportState[] = [];
  const cancelController = createFitYByXReportController({
    onStateChange: (state) => {
      canceledStates.push(state);
    },
    getDatasetGeneration: () => cancelGeneration.promise,
    run: () => cancelRun.promise,
  });

  const pending = cancelController.load(item);
  cancelController.cancel();
  cancelGeneration.resolve(10);
  await flushMicrotasks();
  cancelRun.resolve(makeNotComputableResult());
  await pending;
  assert.equal(canceledStates.at(-1)?.status, "idle");

  const unmountGeneration = createDeferred<number>();
  const unmountRun = createDeferred<FitYByXResult>();
  const unmountedStates: FitYByXReportState[] = [];
  const unmountController = createFitYByXReportController({
    onStateChange: (state) => {
      unmountedStates.push(state);
    },
    getDatasetGeneration: () => unmountGeneration.promise,
    run: () => unmountRun.promise,
  });

  const unmounted = unmountController.load(item);
  unmountController.dispose();
  unmountGeneration.resolve(11);
  await unmounted;
  assert.equal(unmountedStates.at(-1)?.status, "loading");
}

async function testReloadsSameItemWhenGenerationChangesAndIgnoresStaleGenerationFetch(): Promise<void> {
  const item = createItem({ personality: "oneway", factor: { name: "group", type: "ordinal" } });
  const generationA = createDeferred<number>();
  const generationB = createDeferred<number>();
  const runA = createDeferred<FitYByXResult>();
  const runB = createDeferred<FitYByXResult>();
  const states: FitYByXReportState[] = [];
  const requests: FitYByXRequest[] = [];
  let generationCalls = 0;

  const controller = createFitYByXReportController({
    onStateChange: (state) => {
      states.push(state);
    },
    getDatasetGeneration: async () => {
      generationCalls += 1;
      return generationCalls === 1 ? generationA.promise : generationB.promise;
    },
    run: async (request) => {
      requests.push(request);
      return request.generation === 12 ? runB.promise : runA.promise;
    },
  });

  const staleFetch = controller.load(item);
  const activeLoad = controller.load(item);

  generationB.resolve(12);
  await flushMicrotasks();
  assert.equal(requests.length, 1);
  const activeRequest = requests[0]!;
  assert.equal(activeRequest.generation, 12);
  assert.equal(activeRequest.personality, "oneway");

  generationA.resolve(4);
  await flushMicrotasks();
  assert.equal(requests.length, 1);

  const result = makeOnewayResult({
    effectSizes: { etaSquared: 0.25, omegaSquared: null },
  });
  runB.resolve(result);
  await activeLoad;
  expectSuccess(states.at(-1)!, activeRequest, result);

  runA.resolve(makeOnewayResult({ usedRows: 99 }));
  await staleFetch;
  expectSuccess(states.at(-1)!, activeRequest, result);
}

await testLaterRequestWinsWhenEarlierCompletionArrivesLast();
await testNormalizesErrorsAndIgnoresCancelAndUnmount();
await testReloadsSameItemWhenGenerationChangesAndIgnoresStaleGenerationFetch();

console.log("fitYByX report state contract passed");