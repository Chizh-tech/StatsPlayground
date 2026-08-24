import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GRAPH_TABLE_PAGE_SIZE,
  loadGraphTableData,
  type GraphTablePage,
} from "../src/components/graphBuilder/loadGraphTableData.ts";

{
  const events: string[] = [];
  const pages: GraphTablePage[] = [
    { columns: ["value"], rows: [[1], [2]], totalRows: 3, generation: 7 },
    { columns: ["value"], rows: [[3]], totalRows: 3, generation: 7 },
  ];

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
  });

  assert.equal(GRAPH_TABLE_PAGE_SIZE, 2000);
  assert.deepEqual(result, { columns: ["value"], rows: [[1], [2], [3]] });
  assert.deepEqual(events, ["start-0", "yield", "start-2"]);
}

{
  for (const rows of [[], Array.from({ length: 2000 }, (_, index) => [index])]) {
    let requests = 0;
    const result = await loadGraphTableData({
      datasetId: "boundary",
      generation: 3,
      signal: new AbortController().signal,
      queryWindow: async () => {
        requests += 1;
        return { columns: ["value"], rows, totalRows: rows.length, generation: 3 };
      },
    });
    assert.equal(result?.rows.length, rows.length);
    assert.equal(requests, 1);
  }
}

{
  const controller = new AbortController();
  const requestedPages: number[] = [];
  const result = await loadGraphTableData({
    datasetId: "abort-after-response",
    generation: 1,
    signal: controller.signal,
    queryWindow: async (_datasetId, start) => {
      requestedPages.push(start);
      controller.abort();
      return { columns: ["value"], rows: [[1]], totalRows: 2, generation: 1 };
    },
  });

  assert.equal(result, null);
  assert.deepEqual(requestedPages, [0]);
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
}

console.log("cancellable graph table loader passed");
