import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("../src/components/Workspace.tsx", import.meta.url), "utf8").replace(/\r\n/g, "\n");

assert.match(
  source,
  /try \{\s*await dataService\.renameDataset\(id, resolved\.basename\);\s*await refreshDatasets\(\);[\s\S]*?\} catch \(error\) \{/,
  "Dataset rename must catch backend failures around blur/Enter submit path",
);

assert.match(
  source,
  /alert\(t\("alert\.renameTableFailed", \{[\s\S]*?defaultValue: "Rename table failed: ",/,
  "Dataset rename failure must use the existing alert pattern",
);

assert.match(
  source,
  /onBlur=\{\(\) => void handleRenameSubmit\(ds\.id\)\}/,
  "Dataset rename onBlur should submit async rename without leaving unhandled Promise",
);

assert.match(
  source,
  /if \(e\.key === "Enter"\) void handleRenameSubmit\(ds\.id\);/,
  "Dataset rename Enter key should submit async rename without leaving unhandled Promise",
);

console.log("workspace rename failure contract passed");
