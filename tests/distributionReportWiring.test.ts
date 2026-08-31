import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL("../src/components/distribution/DistributionReport.tsx", import.meta.url),
  "utf8",
);
const workspaceSource = readFileSync(
  new URL("../src/components/Workspace.tsx", import.meta.url),
  "utf8",
);

assert.match(
  source,
  /const overviewSpecificationLines = visible\.specificationLines\s*\?\s*\(capabilityBlock\?\.capabilityData\?\.chartData\?\.specificationLines\s*\?\?\s*capabilityBlock\?\.capabilityData\?\.specification\)\s*:\s*undefined;/,
);
assert.match(
  source,
  /<DistributionOverviewChart[\s\S]*valueAxisName=\{result\.yName\}[\s\S]*densityAxisName=\{t\("distribution\.report\.probabilityDensity"\)\}/,
);
assert.doesNotMatch(source, /histogramScale=\{visible\.histogramScale\}/);
assert.match(
  workspaceSource,
  /applyContinuousFitChange\(item, continuousFit, \{[\s\S]*commitConfig: commitDistributionConfig[\s\S]*startRun: handleStartDistributionRun/,
);
assert.match(
  workspaceSource,
  /handleStartDistributionRun[\s\S]*useDistributionStore\.getState\(\)\.runStateByAnalysisId\[item\.analysisId\]/,
);
assert.match(
  source,
  /DISTRIBUTION_FIT_CAPABILITY_REGISTRY[\s\S]*onContinuousFitChange/,
);

console.log("distribution report wiring OK");