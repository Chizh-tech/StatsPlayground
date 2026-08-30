import assert from "node:assert/strict";

import type { ProjectInfo } from "../src/types/project";
import type { SaveProgress, SaveProjectFolders, SaveProjectRequest } from "../src/services/projectService";
import { createProjectStore } from "../src/stores/useProjectStore.ts";
import { useGraphBuilderStore } from "../src/stores/useGraphBuilderStore.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

function continuous(name: string) {
  return { name, type: "continuous" as const };
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

const saveFolders: SaveProjectFolders = {
  folders: [],
  tableFolders: {},
  graphFolders: {},
  fitYByXFolders: { "fit-1": "Analyses" },
  tabulateFolders: {},
};

const request: SaveProjectRequest = {
  history: [],
  snapshots: [],
  graphBuilders: [],
  fitYByX: [{ id: "fit-1", sourceDatasetId: "table-1" }],
  tabulates: [],
  ...saveFolders,
};

const savedProject: ProjectInfo = {
  name: "Project",
  filePath: "C:/tmp/project.spprj",
  createdAt: new Date(0).toISOString(),
};

function makeProgress(overallProgress: number, tableIndex = 0): SaveProgress {
  return {
    phase: "table",
    tableIndex,
    tableTotal: 2,
    tableName: `T${tableIndex + 1}`,
    rowsDone: Math.round(overallProgress * 1000),
    rowsTotal: 1000,
    overallProgress,
  };
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

function resetGraphBuilderStore() {
  useGraphBuilderStore.getState().reset();
}

{
  resetGraphBuilderStore();

  const correlationGraph = {
    id: "graph-corr",
    name: "Correlation Graph",
    sourceDatasetId: "dataset-1",
    mode: "multivariate",
    modeStates: {
      twoD: {
        encoding: {},
        multiX: [],
        multiY: [],
        elements: [{ kind: "points", enabled: true }],
        smootherLambda: 0.4,
      },
      threeD: {
        encoding: {},
        elements: [{ kind: "scatter3d", enabled: true }],
        smootherLambda: 0.4,
      },
      multivariate: {
        columns: [continuous("height"), continuous("weight")],
        chartType: "correlationMatrix",
        correlationMethod: "kendall",
      },
    },
    createdAt: new Date(0).toISOString(),
  };
  const inputGraphs = [correlationGraph] as GraphBuilderItem[];
  const baseline = JSON.stringify(inputGraphs);

  let capturedSaveRequest: SaveProjectRequest | null = null;

  const store = createProjectStore({
    projectService: {
      initProject: async () => savedProject,
      createProject: async () => savedProject,
      openProject: async () => ({
        project: savedProject,
        datasets: [],
        history: [],
        snapshots: [],
        graphBuilders: [],
        fitYByX: [],
        tabulates: [],
        folders: [],
        tableFolders: {},
        graphFolders: {},
        fitYByXFolders: {},
        tabulateFolders: {},
        datasetNameMigrations: [],
      }),
      saveProject: async (req) => {
        capturedSaveRequest = req;
        return savedProject;
      },
      getCurrentProject: async () => savedProject,
    },
  });

  useGraphBuilderStore.getState().loadFromProject(inputGraphs);
  const loaded = useGraphBuilderStore.getState().items[0] as GraphBuilderItem;

  assert.equal(loaded.mode, "multivariate");
  assert.deepEqual(loaded.modeStates.multivariate, {
    columns: [continuous("height"), continuous("weight")],
    chartType: "correlationMatrix",
    correlationMethod: "kendall",
  });

  await store.getState().saveProject({
    ...request,
    graphBuilders: useGraphBuilderStore.getState().items,
  });

  assert.deepEqual(capturedSaveRequest, {
    ...request,
    graphBuilders: useGraphBuilderStore.getState().items,
  });
  assert.deepEqual(capturedSaveRequest?.fitYByX, request.fitYByX);
  assert.deepEqual(capturedSaveRequest?.fitYByXFolders, request.fitYByXFolders);

  const savedGraph = capturedSaveRequest?.graphBuilders[0] as GraphBuilderItem;
  assert.equal(savedGraph.mode, "multivariate");
  assert.deepEqual(savedGraph.modeStates.multivariate, {
    columns: [continuous("height"), continuous("weight")],
    chartType: "correlationMatrix",
    correlationMethod: "kendall",
  });
  for (const legacyKey of ["threeD", "encoding", "multiX", "multiY", "elements"]) {
    assert.equal(Object.hasOwn(savedGraph, legacyKey), false);
  }
  assert.equal(JSON.stringify(inputGraphs), baseline);
}

{
  resetGraphBuilderStore();

  const legacyCorrelationGraph: GraphBuilderItem = {
    id: "graph-legacy-corr",
    name: "Legacy Correlation Graph",
    sourceDatasetId: "dataset-1",
    encoding: {},
    multiX: [
      { name: "left", type: "continuous" },
      { name: "right", type: "continuous" },
    ],
    elements: [{ kind: "correlationMatrix", enabled: true }],
    smootherLambda: 0.5,
    createdAt: new Date(0).toISOString(),
  };
  const baseline = JSON.stringify(legacyCorrelationGraph);
  let capturedSaveRequest: SaveProjectRequest | null = null;

  const store = createProjectStore({
    projectService: {
      initProject: async () => savedProject,
      createProject: async () => savedProject,
      openProject: async () => ({
        project: savedProject,
        datasets: [],
        history: [],
        snapshots: [],
        graphBuilders: [],
        fitYByX: [],
        tabulates: [],
        folders: [],
        tableFolders: {},
        graphFolders: {},
        fitYByXFolders: {},
        tabulateFolders: {},
        datasetNameMigrations: [],
      }),
      saveProject: async (req) => {
        capturedSaveRequest = req;
        return savedProject;
      },
      getCurrentProject: async () => savedProject,
    },
  });

  useGraphBuilderStore.getState().loadFromProject([legacyCorrelationGraph]);
  const loaded = useGraphBuilderStore.getState().items[0] as GraphBuilderItem;

  assert.equal(loaded.mode, "multivariate");
  assert.deepEqual(loaded.modeStates.multivariate, {
    columns: [continuous("left"), continuous("right")],
    chartType: "correlationMatrix",
    correlationMethod: "pearson",
  });
  for (const legacyKey of ["threeD", "encoding", "multiX", "multiY", "elements"]) {
    assert.equal(Object.hasOwn(loaded, legacyKey), false);
  }

  await store.getState().saveProject({
    ...request,
    graphBuilders: useGraphBuilderStore.getState().items,
  });

  const savedGraph = capturedSaveRequest?.graphBuilders[0] as GraphBuilderItem;
  assert.equal(savedGraph.mode, "multivariate");
  assert.deepEqual(savedGraph.modeStates.multivariate, {
    columns: [continuous("left"), continuous("right")],
    chartType: "correlationMatrix",
    correlationMethod: "pearson",
  });
  for (const legacyKey of ["threeD", "encoding", "multiX", "multiY", "elements"]) {
    assert.equal(Object.hasOwn(savedGraph, legacyKey), false);
  }
  assert.equal(JSON.stringify(legacyCorrelationGraph), baseline);
}

{
  resetGraphBuilderStore();

  const saveDeferred = deferred<ProjectInfo>();
  let onProgressRef: ((progress: SaveProgress) => void) | undefined;
  let readOnlyAtInvoke = false;

  const store = createProjectStore({
    projectService: {
      initProject: async () => savedProject,
      createProject: async () => savedProject,
      openProject: async () => ({ project: savedProject, datasets: [], history: [], snapshots: [], graphBuilders: [], fitYByX: [], tabulates: [], folders: [], tableFolders: {}, graphFolders: {}, fitYByXFolders: {}, tabulateFolders: {}, datasetNameMigrations: [] }),
      saveProject: (_request, onProgress) => {
        onProgressRef = onProgress;
        readOnlyAtInvoke = store.getState().readOnly;
        return saveDeferred.promise;
      },
      getCurrentProject: async () => savedProject,
    },
  });

  store.setState({ dirty: true, project: { ...savedProject, name: "Before" } });
  const savePromise = store.getState().saveProject(request);

  assert.equal(store.getState().saving, true);
  assert.equal(store.getState().readOnly, true);
  assert.equal(readOnlyAtInvoke, true);

  onProgressRef?.(makeProgress(0.6));
  onProgressRef?.(makeProgress(0.2));
  assert.equal(store.getState().saveProgress?.overallProgress, 0.6);

  saveDeferred.resolve({ ...savedProject, name: "After" });
  await savePromise;

  assert.equal(store.getState().dirty, false);
  assert.equal(store.getState().project?.name, "After");
  assert.equal(store.getState().saveError, null);
  assert.equal(store.getState().saving, false);
  assert.equal(store.getState().readOnly, false);
  assert.equal(store.getState().saveProgress, null);

  onProgressRef?.(makeProgress(0.9));
  assert.equal(store.getState().saveProgress, null);
}

{
  resetGraphBuilderStore();

  const saveDeferred = deferred<ProjectInfo>();
  let onProgressRef: ((progress: SaveProgress) => void) | undefined;
  let capturedSaveRequest: SaveProjectRequest | null = null;

  const store = createProjectStore({
    projectService: {
      initProject: async () => savedProject,
      createProject: async () => savedProject,
      openProject: async () => ({ project: savedProject, datasets: [], history: [], snapshots: [], graphBuilders: [], fitYByX: [], tabulates: [], folders: [], tableFolders: {}, graphFolders: {}, fitYByXFolders: {}, tabulateFolders: {}, datasetNameMigrations: [] }),
      saveProject: (saveRequest, onProgress) => {
        capturedSaveRequest = saveRequest;
        onProgressRef = onProgress;
        return saveDeferred.promise;
      },
      getCurrentProject: async () => savedProject,
    },
  });

  store.setState({ dirty: false });
  const savePromise = store.getState().saveProject(request);
  onProgressRef?.(makeProgress(0.4));
  saveDeferred.reject(new Error("save failed"));
  await assert.rejects(savePromise, /save failed/);

  assert.deepEqual(capturedSaveRequest, request);

  assert.equal(store.getState().dirty, false);
  assert.match(store.getState().saveError ?? "", /save failed/);
  assert.equal(store.getState().saving, false);
  assert.equal(store.getState().readOnly, false);
  assert.equal(store.getState().saveProgress, null);

  onProgressRef?.(makeProgress(0.7));
  assert.equal(store.getState().saveProgress, null);
}

{
  resetGraphBuilderStore();

  const saveDeferred = deferred<ProjectInfo>();

  const store = createProjectStore({
    projectService: {
      initProject: async () => savedProject,
      createProject: async () => savedProject,
      openProject: async () => ({ project: savedProject, datasets: [], history: [], snapshots: [], graphBuilders: [], fitYByX: [], tabulates: [], folders: [], tableFolders: {}, graphFolders: {}, fitYByXFolders: {}, tabulateFolders: {}, datasetNameMigrations: [] }),
      saveProject: () => saveDeferred.promise,
      getCurrentProject: async () => savedProject,
    },
  });

  store.setState({ dirty: true });
  const first = store.getState().saveProject(request);
  await flushMicrotasks();

  await assert.rejects(
    store.getState().saveProject(request),
    /already in progress/i,
  );

  saveDeferred.resolve(savedProject);
  await first;
}

console.log("useProjectStore save lifecycle passed");
