import assert from "node:assert/strict";

import {
  allocateProjectBasename,
  normalizeProjectBasenameInput,
  projectFileExtension,
  validateProjectBasename,
  type ProjectFileExtension,
} from "../src/utils/projectFileNaming.ts";

assert.equal(projectFileExtension("table"), ".sptb");
assert.equal(projectFileExtension("graph"), ".spgh");
assert.equal(projectFileExtension("fitYByX"), ".spf");
assert.equal(projectFileExtension("tabulate"), ".spf");
assert.equal(projectFileExtension("snapshot"), ".spf");

// Cross-extension coexistence is allowed because each extension namespace is isolated.
assert.equal(
  allocateProjectBasename("data", ".sptb", ["data", "other"]),
  "data-2",
);
assert.equal(
  allocateProjectBasename("data", ".spgh", ["graph-1"]),
  "data",
);
assert.equal(
  allocateProjectBasename("data", ".spf", ["data"]),
  "data-2",
);

// Fit Y by X and Tabulate share the same .spf namespace.
const spfNamespace = ["report", "report-2"];
assert.equal(allocateProjectBasename("report", ".spf", spfNamespace), "report-3");

// Case-insensitive collision and deterministic -N progression.
assert.equal(allocateProjectBasename("DATA", ".sptb", ["data"]), "DATA-2");
assert.equal(allocateProjectBasename("name", ".sptb", ["name", "name-2", "Name-3"]), "name-4");

// Exclude current item during rename so unchanged/case-only rename does not self-conflict.
assert.equal(
  allocateProjectBasename("Sample", ".sptb", ["sample", "sample-2"], "sample"),
  "Sample",
);
assert.equal(
  allocateProjectBasename("sample", ".sptb", ["sample", "sample-2"], "sample-2"),
  "sample-2",
);

// Input normalization and extension stripping behavior.
assert.deepEqual(normalizeProjectBasenameInput("table.sptb", ".sptb"), {
  basename: "table",
  strippedExtension: true,
  wrongExtension: null,
});
assert.deepEqual(normalizeProjectBasenameInput("TABLE.SPGB", ".spgh"), {
  basename: "TABLE.SPGB",
  strippedExtension: false,
  wrongExtension: null,
});
assert.deepEqual(normalizeProjectBasenameInput("table.spgh", ".sptb"), {
  basename: "table.spgh",
  strippedExtension: false,
  wrongExtension: ".spgh",
});
assert.deepEqual(normalizeProjectBasenameInput(".sptb", ".sptb"), {
  basename: "",
  strippedExtension: true,
  wrongExtension: null,
});

// Validation categories.
assert.equal(validateProjectBasename(""), "empty");
assert.equal(validateProjectBasename(" bad"), "edgeDots");
assert.equal(validateProjectBasename("bad "), "edgeDots");
assert.equal(validateProjectBasename(".bad"), "edgeDots");
assert.equal(validateProjectBasename("bad."), "edgeDots");
assert.equal(validateProjectBasename("a/b"), "invalidChars");
assert.equal(validateProjectBasename("a:b"), "invalidChars");
assert.equal(validateProjectBasename("name\u0001"), "controlChars");
assert.equal(validateProjectBasename("NUL"), "reserved");
assert.equal(validateProjectBasename("com1"), "reserved");
assert.equal(validateProjectBasename("Lpt9.log"), "reserved");
assert.equal(validateProjectBasename(normalizeProjectBasenameInput(".sptb", ".sptb").basename), "empty");
assert.equal(validateProjectBasename("good.name"), null);

// Snapshot namespace is separate from active .spf docs.
const activeSpf = ["snapshot", "summary"];
const snapshots = ["snapshot", "snapshot-2"];
assert.equal(allocateProjectBasename("snapshot", ".spf", activeSpf), "snapshot-2");
assert.equal(allocateProjectBasename("snapshot", ".spf", snapshots), "snapshot-3");

const explicitExtension: ProjectFileExtension = ".spf";
assert.equal(explicitExtension, ".spf");

console.log("project-file-naming contract passed");
