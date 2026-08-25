import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GRAPH_TABLE_PAGE_SIZE,
  loadGraphTableData,
  type GraphTablePage,
  type GraphTableLoadProgress,
} from "../src/components/graphBuilder/loadGraphTableData.ts";
import { GraphTableDataCache } from "../src/utils/graphTableDataCache.ts";

{
  const events: string[] = [];
  const pages: GraphTablePage[] = [
    { columns: ["value"], rows: [[1], [2]], totalRows: 3, generation: 7 },
    { columns: ["value"], rows: [[3]], totalRows: 3, generation: 7 },
  ];
  const progress: GraphTableLoadProgress[] = [];

  const result = await loadGraphTableData({
    datasetId: "large",
    generation: 7,
    signal: new AbortController().signal,
    queryWindow: async (datasetId, start, count, generation) => {
      assert.equal(datasetId, "large");
      assert.equal(count, 2000);
      assert.equal(generation, 7);
      events.push(`start-${start}`);
      return pages[start === 0 ? 0 : 1];
    },
    yieldToBrowser: async () => {
      events.push("yield");
    },
    onProgress: (next) => progress.push(next),
  });

  assert.equal(GRAPH_TABLE_PAGE_SIZE, 2000);
  assert.deepEqual(result, { columns: ["value"], rows: [[1], [2], [3]] });
  assert.deepEqual(events, ["start-0", "yield", "start-2"]);
  assert.deepEqual(progress, [
    { loadedRows: 2, totalRows: 3 },
    { loadedRows: 3, totalRows: 3 },
  ]);
}

{
  for (const rows of [[], Array.from({ length: 2000 }, (_, index) => [index])]) {
    let requests = 0;
    const progress: GraphTableLoadProgress[] = [];
    const result = await loadGraphTableData({
      datasetId: "boundary",
      generation: 3,
      signal: new AbortController().signal,
      queryWindow: async () => {
        requests += 1;
        return { columns: ["value"], rows, totalRows: rows.length, generation: 3 };
      },
      onProgress: (p) => progress.push(p),
    });
    assert.equal(result?.rows.length, rows.length);
    assert.equal(requests, 1);
    if (rows.length === 0) {
      assert.deepEqual(progress, [{ loadedRows: 0, totalRows: 0 }]);
    }
  }
}

{
  const cache = new GraphTableDataCache();
  const cached = { columns: ["value"], rows: [[1], [2]] };
  cache.putIfCurrent(cache.captureEpoch(), "cached", 9, cached);
  let requests = 0;

  const result = await loadGraphTableData({
    datasetId: "cached",
    generation: 9,
    signal: new AbortController().signal,
    cache,
    cacheEpoch: cache.captureEpoch(),
    queryWindow: async () => {
      requests += 1;
      throw new Error("cache hit should skip queries");
    },
  });

  assert.equal(result, cached);
  assert.equal(requests, 0);
}

{
  const cache = new GraphTableDataCache();
  const cacheEpoch = cache.captureEpoch();
  let requests = 0;

  const result = await loadGraphTableData({
    datasetId: "miss",
    generation: 5,
    signal: new AbortController().signal,
    cache,
    cacheEpoch,
    queryWindow: async () => {
      requests += 1;
      return {
        columns: ["value"],
        rows: [[1], [2]],
        totalRows: 2,
        generation: 5,
      };
    },
  });

  assert.deepEqual(result, { columns: ["value"], rows: [[1], [2]] });
  assert.equal(requests, 1);
  assert.equal(cache.get("miss", 5), result);
}

{
  const cache = new GraphTableDataCache();
  const cacheEpoch = cache.captureEpoch();
  let requests = 0;

  const result = await loadGraphTableData({
    datasetId: "empty-miss",
    generation: 6,
    signal: new AbortController().signal,
    cache,
    cacheEpoch,
    queryWindow: async () => {
      requests += 1;
      return {
        columns: ["value"],
        rows: [],
        totalRows: 0,
        generation: 6,
      };
    },
  });

  assert.deepEqual(result, { columns: ["value"], rows: [] });
  assert.equal(requests, 1);
  assert.equal(cache.get("empty-miss", 6), result);
}

{
  const controller = new AbortController();
  const requestedPages: number[] = [];
  const progress: GraphTableLoadProgress[] = [];
  const result = await loadGraphTableData({
    datasetId: "abort-after-response",
    generation: 1,
    signal: controller.signal,
    queryWindow: async (_datasetId, start) => {
      requestedPages.push(start);
      controller.abort();
      return { columns: ["value"], rows: [[1]], totalRows: 2, generation: 1 };
    },
    onProgress: (p) => progress.push(p),
  });

  assert.equal(result, null);
  assert.deepEqual(requestedPages, [0]);
  assert.deepEqual(progress, []);
}

{
  const cache = new GraphTableDataCache();
  const cacheEpoch = cache.captureEpoch();
  const controller = new AbortController();
  const result = await loadGraphTableData({
    datasetId: "abort-no-cache",
    generation: 1,
    signal: controller.signal,
    cache,
    cacheEpoch,
    queryWindow: async () => {
      controller.abort();
      return { columns: ["value"], rows: [[1]], totalRows: 1, generation: 1 };
    },
  });

  assert.equal(result, null);
  assert.equal(cache.get("abort-no-cache", 1), undefined);
}

{
  const controller = new AbortController();
  const requestedPages: number[] = [];
  const result = await loadGraphTableData({
    datasetId: "abort-during-yield",
    generation: 1,
    signal: controller.signal,
    queryWindow: async (_datasetId, start) => {
      requestedPages.push(start);
      return { columns: ["value"], rows: [[1]], totalRows: 2, generation: 1 };
    },
    yieldToBrowser: async () => {
      controller.abort();
    },
  });

  assert.equal(result, null);
  assert.deepEqual(requestedPages, [0]);
}

{
  const controller = new AbortController();
  let resolvePage: ((page: GraphTablePage) => void) | undefined;
  const pending = loadGraphTableData({
    datasetId: "late-response",
    generation: 1,
    signal: controller.signal,
    queryWindow: () => new Promise((resolve) => {
      resolvePage = resolve;
    }),
  });

  controller.abort();
  resolvePage?.({ columns: ["value"], rows: [[1]], totalRows: 1, generation: 1 });
  assert.equal(await pending, null);
}

{
  const expected = new Error("query failed");
  const cache = new GraphTableDataCache();
  await assert.rejects(
    loadGraphTableData({
      datasetId: "failure",
      generation: 1,
      signal: new AbortController().signal,
      cache,
      cacheEpoch: cache.captureEpoch(),
      queryWindow: async () => {
        throw expected;
      },
    }),
    (error) => error === expected,
  );
  assert.equal(cache.get("failure", 1), undefined);
}

{
  const cache = new GraphTableDataCache();
  await assert.rejects(
    loadGraphTableData({
      datasetId: "changed",
      generation: 4,
      signal: new AbortController().signal,
      cache,
      cacheEpoch: cache.captureEpoch(),
      queryWindow: async () => ({
        columns: ["value"],
        rows: [[1]],
        totalRows: 1,
        generation: 5,
      }),
    }),
    /dataset changed during graph loading/i,
  );
  assert.equal(cache.get("changed", 4), undefined);

  // ensure no progress callback on generation mismatch
  await assert.rejects(
    loadGraphTableData({
      datasetId: "changed-cb",
      generation: 4,
      signal: new AbortController().signal,
      queryWindow: async () => ({
        columns: ["value"],
        rows: [[1]],
        totalRows: 1,
        generation: 5,
      }),
      onProgress: () => {
        throw new Error("progress should not be called on generation mismatch");
      },
    }),
    /dataset changed during graph loading/i,
  );
}

{
  const cache = new GraphTableDataCache();
  const cacheEpoch = cache.captureEpoch();
  let resolveSecondPage: ((page: GraphTablePage) => void) | undefined;
  let markSecondPageRequested: (() => void) | undefined;
  const secondPageRequested = new Promise<void>((resolve) => {
    markSecondPageRequested = resolve;
  });
  let requests = 0;

  const pending = loadGraphTableData({
    datasetId: "cleared-mid-flight",
    generation: 8,
    signal: new AbortController().signal,
    cache,
    cacheEpoch,
    queryWindow: async (_datasetId, start) => {
      requests += 1;
      if (start === 0) {
        return { columns: ["value"], rows: [[1]], totalRows: 2, generation: 8 };
      }
      markSecondPageRequested?.();
      return new Promise((resolve) => {
        resolveSecondPage = resolve;
      });
    },
    yieldToBrowser: async () => {
      // keep the second page request on the original epoch
    },
  });

  await secondPageRequested;
  cache.clear();
  resolveSecondPage?.({ columns: ["value"], rows: [[2]], totalRows: 2, generation: 8 });
  const result = await pending;

  assert.deepEqual(result, { columns: ["value"], rows: [[1], [2]] });
  assert.equal(cache.get("cleared-mid-flight", 8), undefined);

  const reused = await loadGraphTableData({
    datasetId: "cleared-mid-flight",
    generation: 8,
    signal: new AbortController().signal,
    cache,
    cacheEpoch: cache.captureEpoch(),
    queryWindow: async () => {
      requests += 1;
      return { columns: ["value"], rows: [[9]], totalRows: 1, generation: 8 };
    },
  });

  assert.deepEqual(reused, { columns: ["value"], rows: [[9]] });
  assert.equal(requests, 3);
}

{
  const source = readFileSync(
    new URL("../src/components/graphBuilder/GraphBuilderView.tsx", import.meta.url),
    "utf8",
  );
  assert.match(source, /const controller = new AbortController\(\)/);
  assert.match(source, /loadGraphTableData\(\{/);
  assert.match(source, /signal: controller\.signal/);
  assert.match(source, /dataService\.queryTableWindow\(/);
  assert.match(source, /return \(\) => \{\s*controller\.abort\(\)/);
  assert.doesNotMatch(source, /pageSize: Math\.max\(1, dataset\.rowCount/);
  assert.ok(
    source.indexOf("getDatasetGeneration(dataset.id)")
      < source.indexOf("getColumns(dataset.id)"),
    "the generation must be captured before column metadata",
  );
  assert.ok(
    source.indexOf("graphTableDataCache.captureEpoch()")
      < source.indexOf("await dataService.getDatasetGeneration(dataset.id)"),
    "the cache epoch must be captured before the first await",
  );
  assert.match(source, /cache:\s*graphTableDataCache/);
  assert.match(source, /cacheEpoch/);
  assert.match(source, /setLoadProgress\(null\)/);
  assert.match(source, /onProgress: setLoadProgress/);
  assert.match(
    source,
    /className="sp-progress-bar"\s+role="progressbar"\s+aria-label=\{t\("graph\.loading"\)\}\s+aria-valuemin=\{0\}\s+aria-valuemax=\{100\}\s+aria-valuenow=\{loadPercent \?\? undefined\}/,
  );
  assert.match(source, /className=\{`sp-progress-fill \$\{loadPercent === null \? "sp-progress-indeterminate" : ""\}`\}/);
  assert.match(source, /style=\{loadPercent === null \? undefined : \{ width: `\$\{loadPercent\}%` \}\}/);
  assert.match(source, /t\("graph\.loadingProgress"/);

  const projectStoreSource = readFileSync(
    new URL("../src/stores/useProjectStore.ts", import.meta.url),
    "utf8",
  );
  assert.match(projectStoreSource, /initProject: async \(\) => \{[\s\S]*graphTableDataCache\.clear\(\)[\s\S]*deps\.projectService\.initProject\(/);
  assert.match(projectStoreSource, /createProject: async \(name, filePath\) => \{[\s\S]*graphTableDataCache\.clear\(\)[\s\S]*deps\.projectService\.createProject\(/);
  assert.match(projectStoreSource, /openProject: async \(filePath\) => \{[\s\S]*graphTableDataCache\.clear\(\)[\s\S]*deps\.projectService\.openProject\(/);

  const workspaceSource = readFileSync(
    new URL("../src/components/Workspace.tsx", import.meta.url),
    "utf8",
  );
  assert.match(workspaceSource, /graphTableDataCache\.invalidateDataset\(id\)[\s\S]*dataService\.deleteDataset\(id\)/);

  for (const locale of ["en", "vi", "zh-CN", "zh-TW"]) {
    const localeSource = readFileSync(
      new URL(`../src/i18n/locales/${locale}.json`, import.meta.url),
      "utf8",
    );
    const parsed = JSON.parse(localeSource) as {
      graph?: { loadingProgress?: string };
    };
    const loadingProgress = parsed.graph?.loadingProgress;
    assert.equal(typeof loadingProgress, "string", `missing graph.loadingProgress in ${locale}`);
    assert.ok(loadingProgress.trim().length > 0, `graph.loadingProgress empty in ${locale}`);
    assert.match(loadingProgress, /\{\{loaded\}\}/, `graph.loadingProgress missing {{loaded}} in ${locale}`);
    assert.match(loadingProgress, /\{\{total\}\}/, `graph.loadingProgress missing {{total}} in ${locale}`);
  }
}

console.log("cancellable graph table loader passed");
