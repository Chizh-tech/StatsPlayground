import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

function read(relativePath: string): string {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8").replace(/\r\n/g, "\n");
}

const namingSource = read("../src/utils/projectFileNaming.ts");
assert.match(
  namingSource,
  /export function resolveProjectBasenameForKind\(/,
  "projectFileNaming must export resolveProjectBasenameForKind for shared create/rename naming policy",
);

const workspaceSource = read("../src/components/Workspace.tsx");
assert.match(
  workspaceSource,
  /resolveProjectBasenameForKind\(\s*`Table\$\{tableCounter\.current\}`,\s*"table"/,
  "Workspace new-table creation must go through shared naming resolution utility",
);

const sqlQuerySource = read("../src/components/SqlQueryDialog.tsx");
assert.match(
  sqlQuerySource,
  /resolveProjectBasenameForKind\(\s*newTableName,\s*"table"/,
  "SqlQueryDialog table creation must go through shared naming resolution utility",
);

const extrasSource = read("../src/components/ManageExtrasDialog.tsx");
assert.match(
  extrasSource,
  /resolveProjectBasenameForKind\(\s*proposed,\s*"table"/,
  "ManageExtrasDialog export-table creation must go through shared naming resolution utility",
);

assert.match(
  sqlQuerySource,
  /if \(resolved\.error === "wrongExtension"\)/,
  "SqlQueryDialog must surface a clear wrong-extension invalid-name error",
);
assert.match(
  extrasSource,
  /if \(resolved\.error === "wrongExtension"\)/,
  "ManageExtrasDialog must surface a clear wrong-extension invalid-name error",
);

console.log("project-file-naming integration contract passed");
