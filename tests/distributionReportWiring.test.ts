import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const reportSource = readFileSync(
  new URL("../src/components/distribution/DistributionReport.tsx", import.meta.url),
  "utf8",
);
const capabilitySource = readFileSync(
  new URL("../src/components/distribution/ProcessCapabilityReport.tsx", import.meta.url),
  "utf8",
);
const viewSource = readFileSync(
  new URL("../src/components/distribution/DistributionView.tsx", import.meta.url),
  "utf8",
);

assert.match(reportSource, /DistributionGroupResult/);
assert.match(reportSource, /DistributionReportBlock/);
assert.match(reportSource, /<details/);
assert.match(reportSource, /SummaryDataTables/);
assert.match(reportSource, /ContinuousFitComparisonReport/);
assert.match(reportSource, /ProcessCapabilityReport/);
assert.doesNotMatch(reportSource, /DistributionChart|GraphRuntime|useDistributionReport|useDistributionStore/);
assert.doesNotMatch(capabilitySource, /DistributionChart|ProcessCapabilityChart|echarts/);

assert.match(viewSource, /useDistributionReport/);
assert.match(viewSource, /<DistributionReport/);
assert.match(viewSource, /reportState\.status === "error"/);
assert.match(viewSource, /externalDataState=\{mapDistributionExternalDataState\(reportState, role\)\}/);

console.log("distribution report wiring OK");
