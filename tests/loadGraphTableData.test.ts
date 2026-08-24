import assert from "node:assert/strict";

import {
  GRAPH_TABLE_PAGE_SIZE,
  loadGraphTableData,
  type GraphTablePage,
} from "../src/components/graphBuilder/loadGraphTableData.ts";

{
  const events: string[] = [];
  const pages: GraphTablePage[] = [
    { columns: ["value"], rows: [[1], [2]], totalRows: 3 },
    { columns: ["value"], rows: [[3]], totalRows: 3 },
  ];

  const result = await loadGraphTableData({
    datasetId: "large",
    signal: new AbortController().signal,
    queryPage: async (datasetId, page, pageSize) => {
      assert.equal(datasetId, "large");
      assert.equal(pageSize, 4096);
      events.push(`page-${page}`);
      return pages[page];
    },
    yieldToBrowser: async () => {
      events.push("yield");
    },
  });

  assert.equal(GRAPH_TABLE_PAGE_SIZE, 4096);
  assert.deepEqual(result, { columns: ["value"], rows: [[1], [2], [3]] });
  assert.deepEqual(events, ["page-0", "yield", "page-1"]);
}

{
  const controller = new AbortController();
  const requestedPages: number[] = [];
  const result = await loadGraphTableData({
    datasetId: "abort-after-response",
    signal: controller.signal,
    queryPage: async (_datasetId, page) => {
      requestedPages.push(page);
      controller.abort();
      return { columns: ["value"], rows: [[1]], totalRows: 2 };
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
    signal: controller.signal,
    queryPage: async (_datasetId, page) => {
      requestedPages.push(page);
      return { columns: ["value"], rows: [[1]], totalRows: 2 };
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
    signal: controller.signal,
    queryPage: () => new Promise((resolve) => {
      resolvePage = resolve;
    }),
  });

  controller.abort();
  resolvePage?.({ columns: ["value"], rows: [[1]], totalRows: 1 });
  assert.equal(await pending, null);
}

{
  const expected = new Error("query failed");
  await assert.rejects(
    loadGraphTableData({
      datasetId: "failure",
      signal: new AbortController().signal,
      queryPage: async () => {
        throw expected;
      },
    }),
    (error) => error === expected,
  );
}

console.log("cancellable graph table loader passed");
