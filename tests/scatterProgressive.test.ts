import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/graphCore/transform.ts", import.meta.url), "utf8");
const start = source.indexOf("// Raw scatter (no aggregation)");
const end = source.indexOf("case \"line\":", start);

assert.ok(start >= 0, "raw scatter branch marker must exist");
assert.ok(end > start, "line branch marker must follow raw scatter branch");

const branch = source.slice(start, end);

assert.ok(branch.includes('type: "scatter"'), 'raw scatter branch must render scatter series');
assert.ok(branch.includes('progressive: 0'), 'raw scatter branch must disable progressive rendering');
assert.equal((branch.match(/progressive: 0/g) ?? []).length, 1, 'progressive: 0 should appear exactly once in the raw scatter branch');
assert.ok(branch.includes("__pick"), 'raw scatter branch must preserve point metadata');
assert.ok(!branch.includes('large: true'), 'raw scatter branch must not enable large mode');

console.log("scatter progressive source regression passed");