import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GRAPH_TABLE_PAGE_SIZE,
  loadGraphTableData,
  type GraphTablePage,
  type GraphTableLoadProgress,
} from "../src/components/graphBuilder/loadGraphTableData.ts";

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
  await assert.rejects(
    loadGraphTableData({
      datasetId: "failure",
      generation: 1,
      signal: new AbortController().signal,
      queryWindow: async () => {
        throw expected;
      },
    }),
    (error) => error === expected,
  );
}

{
  await assert.rejects(
    loadGraphTableData({
      datasetId: "changed",
      generation: 4,
      signal: new AbortController().signal,
      queryWindow: async () => ({
        columns: ["value"],
        rows: [[1]],
        totalRows: 1,
        generation: 5,
      }),
    }),
    /dataset changed during graph loading/i,
  );

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
  assert.match(source, /setLoadProgress\(null\)/);
  assert.match(source, /onProgress: setLoadProgress/);
  assert.match(
    source,
    /className="sp-progress-bar"\s+role="progressbar"\s+aria-label=\{t\("graph\.loading"\)\}\s+aria-valuemin=\{0\}\s+aria-valuemax=\{100\}\s+aria-valuenow=\{loadPercent \?\? undefined\}/,
  );
  assert.match(source, /className=\{`sp-progress-fill \$\{loadPercent === null \? "sp-progress-indeterminate" : ""\}`\}/);
  assert.match(source, /style=\{loadPercent === null \? undefined : \{ width: `\$\{loadPercent\}%` \}\}/);
  assert.match(source, /t\("graph\.loadingProgress"/);

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
