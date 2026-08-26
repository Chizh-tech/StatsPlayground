import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const typesSource = readFileSync(
  new URL("../src/types/distribution.ts", import.meta.url),
  "utf8",
);
assert.match(typesSource, /sourceLedgerHash:\s*string/);
assert.match(typesSource, /reviewArtifactHash:\s*string/);
assert.match(typesSource, /seed:\s*string/);
assert.match(typesSource, /inputs:\s*Record<string, BlackBoxValueV1>/);
assert.match(typesSource, /expected:\s*BlackBoxObservationV1\[\]/);
assert.match(typesSource, /observed:\s*BlackBoxObservationV1\[\]/);
assert.match(typesSource, /warnings:\s*string\[\]/);
assert.doesNotMatch(typesSource, /legalReviewStatus:\s*string/);
assert.doesNotMatch(typesSource, /productOutput|screenshotText|rawOutput/i);

const ledger = readFileSync(
  new URL(
    "../docs/superpowers/artifacts/2026-08-25-analysis-distribution-source-ledger.md",
    import.meta.url,
  ),
  "utf8",
);
const legalProcess = readFileSync(
  new URL(
    "../docs/superpowers/artifacts/2026-08-25-analysis-distribution-legal-review-process.md",
    import.meta.url,
  ),
  "utf8",
);
assert.match(ledger, /artifactId/);
assert.match(ledger, /allowedFieldKeys/);
assert.match(ledger, /inputHash/);
assert.match(ledger, /outputHash/);
assert.match(legalProcess, /reviewerRole/);
assert.match(legalProcess, /artifactHash/);
assert.match(legalProcess, /notesHash/);
assert.doesNotMatch(legalProcess, /legal advice|legal conclusion|approved for release/i);

console.log("distribution black-box contracts OK");