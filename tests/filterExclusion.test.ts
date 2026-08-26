import assert from "node:assert/strict";

import { applyFilters } from "../src/components/filter/filterEngine.ts";

const data = {
  columns: ["category"],
  rows: [["A"], ["B"], [null]],
};
const field = { name: "category", type: "nominal" as const };

assert.deepEqual(
  applyFilters(data, [{
    id: "pass-through",
    op: "AND",
    rule: { kind: "categorical", field, selected: [], exclude: true },
  }])?.rows,
  data.rows,
);

assert.deepEqual(
  applyFilters(data, [{
    id: "exclude-a",
    op: "AND",
    rule: { kind: "categorical", field, selected: ["A"], exclude: true },
  }])?.rows,
  [["B"], [null]],
);

console.log("filter-exclusion regression passed");