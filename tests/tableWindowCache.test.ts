import assert from "node:assert/strict";

import { TableWindowCache } from "../src/utils/tableWindowCache.ts";
import type { TableWindowRequest, TableWindowResult } from "../src/types/data.ts";

function request(start: number, count: number, generation = 0): TableWindowRequest {
  return {
    datasetId: "dataset-a",
    start,
    count,
    sort: null,
    filters: [],
    generation,
  };
}

function result(start: number, count: number, generation = 0): TableWindowResult {
  return {
    columns: ["_row_id", "value"],
    columnTypes: ["BIGINT", "VARCHAR"],
    rows: Array.from({ length: count }, (_, index) => [start + index + 1, `row-${start + index}`]),
    totalRows: 10_000,
    start,
    generation,
  };
}

{
  const cache = new TableWindowCache(5_000);
  assert.equal(cache.put(request(0, 500), result(0, 500)), true);
  assert.equal(cache.put(request(500, 500), result(500, 500)), true);

  const reused = cache.get(request(250, 500));
  assert.equal(reused?.rows.length, 500);
  assert.equal(reused?.rows[0][0], 251);
  assert.equal(reused?.rows[499][0], 750);
}

{
  const cache = new TableWindowCache(1_000);
  cache.put(request(0, 500), result(0, 500));
  cache.put(request(500, 500), result(500, 500));
  assert.ok(cache.get(request(0, 1)));
  cache.put(request(1_000, 500), result(1_000, 500));

  assert.equal(cache.retainedRows, 1_000);
  assert.ok(cache.get(request(0, 1)));
  assert.equal(cache.get(request(500, 1)), undefined);
  assert.ok(cache.get(request(1_000, 1)));
}

{
  const cache = new TableWindowCache(5_000);
  cache.put(request(0, 500, 1), result(0, 500, 1));

  assert.ok(cache.get(request(0, 500, 1)));
  assert.equal(cache.get(request(0, 500, 2)), undefined);
}

{
  const cache = new TableWindowCache(5_000);
  cache.put(request(0, 500), result(0, 500));
  cache.put(request(500, 500), result(500, 500));
  cache.invalidateRange("dataset-a", 0, 400, 200);

  assert.equal(cache.get(request(0, 500)), undefined);
  assert.equal(cache.get(request(500, 500)), undefined);
  assert.equal(cache.retainedRows, 0);
}

{
  const cache = new TableWindowCache(5_000);
  assert.equal(cache.put(request(0, 500), result(500, 500)), false);
  assert.equal(cache.put(request(0, 500, 1), result(0, 500, 2)), false);
  assert.equal(cache.retainedRows, 0);
}

console.log("table-window-cache regression passed");