import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { useDistributionStore } from "../src/stores/useDistributionStore.ts";

const typesSource = readFileSync(
  new URL("../src/types/distribution.ts", import.meta.url),
  "utf8",
);
assert.match(typesSource, /interface DistributionProgressV1/);
assert.match(typesSource, /interface DistributionCancelTokenV1/);
assert.match(typesSource, /interface DistributionRunStateV1/);

useDistributionStore.getState().startRun({
  runId: "run-1",
  status: "running",
  progress: null,
  snapshotId: "snapshot-1",
  cancelToken: "cancel-1",
});
useDistributionStore.getState().updateProgress({
  runId: "run-1",
  phase: "prepare",
  current: 4,
  total: 10,
  messageKey: "distribution.prepare",
  percent: 40,
});
useDistributionStore.getState().updateProgress({
  runId: "run-1",
  phase: "prepare",
  current: 3,
  total: 10,
  messageKey: "distribution.prepare",
  percent: 30,
});
assert.equal(useDistributionStore.getState().runState?.progress?.current, 4);
useDistributionStore.getState().cancelRun("cancel-1");
assert.equal(useDistributionStore.getState().runState?.status, "cancelled");
useDistributionStore.getState().reset();

console.log("distribution snapshot control plane OK");