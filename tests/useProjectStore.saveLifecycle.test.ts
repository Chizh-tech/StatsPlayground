import assert from "node:assert/strict";

import type { ProjectInfo } from "../src/types/project";
import type { SaveProgress, SaveProjectRequest } from "../src/services/projectService";
import { deriveElements } from "../src/components/graphBuilder/useGraphDataPipeline.ts";
import { createProjectStore } from "../src/stores/useProjectStore.ts";
import type { GraphBuilderItem } from "../src/types/graphBuilder.ts";

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
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

const request: SaveProjectRequest = {
  history: [],
  snapshots: [],
  graphBuilders: [],
  tabulates: [],
  folders: [],
  tableFolders: {},
  graphFolders: {},
  tabulateFolders: {},
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

{
  const correlationGraph = {
    id: "graph-corr",
    name: "Correlation Graph",
    sourceDatasetId: "dataset-1",
    encoding: {},
    multiX: [
      { name: "a", type: "continuous" },
      { name: "b", type: "continuous" },
    ],
    elements: [
      {
        kind: "correlationMatrix",
        enabled: true,
        options: { correlationMethod: "kendall" },
      },
    ],
    smootherLambda: 0.5,
    createdAt: new Date(0).toISOString(),
  };

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
        graphBuilders: [correlationGraph],
        tabulates: [],
        folders: [],
        tableFolders: {},
        graphFolders: {},
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

  const opened = await store.getState().openProject("C:/tmp/project.spprj");
  assert.equal(
    (opened.graphBuilders[0] as { elements?: Array<{ options?: { correlationMethod?: string } }> }).elements?.[0]?.options?.correlationMethod,
    "kendall",
  );

  await store.getState().saveProject({
    ...request,
    graphBuilders: opened.graphBuilders,
  });

  assert.equal(
    (capturedSaveRequest?.graphBuilders[0] as { elements?: Array<{ options?: { correlationMethod?: string } }> }).elements?.[0]?.options?.correlationMethod,
    "kendall",
  );
}

{
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

  const store = createProjectStore({
    projectService: {
      initProject: async () => savedProject,
      createProject: async () => savedProject,
      openProject: async () => ({
        project: savedProject,
        datasets: [],
        history: [],
        snapshots: [],
        graphBuilders: [legacyCorrelationGraph],
        tabulates: [],
        folders: [],
        tableFolders: {},
        graphFolders: {},
        tabulateFolders: {},
        datasetNameMigrations: [],
      }),
      saveProject: async () => savedProject,
      getCurrentProject: async () => savedProject,
    },
  });

  const opened = await store.getState().openProject("C:/tmp/project.spprj");
  const derived = deriveElements(opened.graphBuilders[0] as GraphBuilderItem);
  assert.deepEqual(derived, [
    { kind: "correlationMatrix", summaryStat: "none", correlationMethod: "pearson" },
  ]);
  assert.equal(
    (opened.graphBuilders[0] as { elements?: Array<{ options?: { correlationMethod?: string } }> }).elements?.[0]?.options?.correlationMethod,
    undefined,
  );
  assert.equal(JSON.stringify(legacyCorrelationGraph), baseline);
}

{
  const saveDeferred = deferred<ProjectInfo>();
  let onProgressRef: ((progress: SaveProgress) => void) | undefined;
  let readOnlyAtInvoke = false;

  const store = createProjectStore({
    projectService: {
      initProject: async () => savedProject,
      createProject: async () => savedProject,
      openProject: async () => ({ project: savedProject, datasets: [], history: [], snapshots: [], graphBuilders: [], tabulates: [], folders: [], tableFolders: {}, graphFolders: {}, tabulateFolders: {}, datasetNameMigrations: [] }),
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
  const saveDeferred = deferred<ProjectInfo>();
  let onProgressRef: ((progress: SaveProgress) => void) | undefined;

  const store = createProjectStore({
    projectService: {
      initProject: async () => savedProject,
      createProject: async () => savedProject,
      openProject: async () => ({ project: savedProject, datasets: [], history: [], snapshots: [], graphBuilders: [], tabulates: [], folders: [], tableFolders: {}, graphFolders: {}, tabulateFolders: {}, datasetNameMigrations: [] }),
      saveProject: (_request, onProgress) => {
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

  assert.equal(store.getState().dirty, false);
  assert.match(store.getState().saveError ?? "", /save failed/);
  assert.equal(store.getState().saving, false);
  assert.equal(store.getState().readOnly, false);
  assert.equal(store.getState().saveProgress, null);

  onProgressRef?.(makeProgress(0.7));
  assert.equal(store.getState().saveProgress, null);
}

{
  const saveDeferred = deferred<ProjectInfo>();

  const store = createProjectStore({
    projectService: {
      initProject: async () => savedProject,
      createProject: async () => savedProject,
      openProject: async () => ({ project: savedProject, datasets: [], history: [], snapshots: [], graphBuilders: [], tabulates: [], folders: [], tableFolders: {}, graphFolders: {}, tabulateFolders: {}, datasetNameMigrations: [] }),
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
