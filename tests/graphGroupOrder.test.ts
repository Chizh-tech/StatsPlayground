import assert from "node:assert/strict";

import { resolveStableGroupKeys } from "../src/components/graphBuilder/graphGroupOrder.ts";

const aggregateOrder = ["West", "Central", "East"];
const sampledDictionaryOrder = ["East", "West", "Central"];

assert.deepEqual(
  resolveStableGroupKeys(aggregateOrder, [], undefined),
  ["Central", "East", "West"],
  "aggregate-only group colors should use deterministic slots",
);

assert.deepEqual(
  resolveStableGroupKeys(aggregateOrder, sampledDictionaryOrder, undefined),
  ["Central", "East", "West"],
  "adding sampled points must not reorder existing group color slots",
);

assert.deepEqual(
  resolveStableGroupKeys(
    ["West", "", "   ", null, undefined, "Central", "West"],
    ["East", "Central", null],
    ["West", "East", "West"],
  ),
  ["West", "East", "Central"],
  "explicit Value Order should lead and remaining groups should stay deterministic",
);

console.log("graph group order regressions passed");