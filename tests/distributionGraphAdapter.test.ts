import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { toGraphBuilderInput } from "../src/graphCore/distributionAdapter.ts";

const histogram = {
  kind: "histogramData" as const,
  schemaVersion: "1" as const,
  provenance: { methodId: "synthetic.histogram", snapshotId: "snapshot-1" },
  bins: [{ lower: 0.125, upper: 0.375, count: 7.5 }],
};
const qq = {
  kind: "qqData" as const,
  schemaVersion: "1" as const,
  provenance: { methodId: "synthetic.qq", snapshotId: "snapshot-1" },
  points: [{ x: -1.25, y: -1.125 }, { x: 1.25, y: 1.375 }],
};
assert.deepEqual(toGraphBuilderInput(histogram).payload, histogram);
assert.deepEqual(toGraphBuilderInput(qq).payload, qq);
assert.equal(toGraphBuilderInput(histogram).display.role, "distribution");

const source = readFileSync(
  new URL("../src/graphCore/distributionAdapter.ts", import.meta.url),
  "utf8",
);
assert.doesNotMatch(source, /from ["']\.\/transform|histogramBins\(|quantile\(|computeBox|fitDistribution/i);
console.log("distribution graph adapter OK");