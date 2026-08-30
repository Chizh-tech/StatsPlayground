import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type JsonObject = Record<string, unknown>;

const TEST_FILE_DIR = resolve(process.cwd(), "tests");

function readSource(relativePath: string): string {
  return readFileSync(resolve(TEST_FILE_DIR, relativePath), "utf8").replace(/\r\n/g, "\n");
}

function readJson(relativePath: string): JsonObject {
  return JSON.parse(readSource(relativePath)) as JsonObject;
}

function getPathValue(root: JsonObject, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((current, segment) => {
      if (!current || typeof current !== "object") {
        return undefined;
      }
      return (current as Record<string, unknown>)[segment];
    }, root);
}

function assertSourceIncludes(source: string, needle: string, message: string): void {
  assert.equal(source.includes(needle), true, message);
}

const workspaceSource = readSource("../src/components/Workspace.tsx");

assertSourceIncludes(workspaceSource, "useFitYByXStore", "Workspace must consume the Fit Y by X store");
assertSourceIncludes(workspaceSource, "FitYByXRoleDialog", "Workspace must render the Fit Y by X role dialog");
assertSourceIncludes(workspaceSource, "FitYByXView", "Workspace must render the Fit Y by X main-pane view");

assertSourceIncludes(workspaceSource, "menu.fitYByX", "Analysis menu must include menu.fitYByX");
assertSourceIncludes(workspaceSource, "handleCreateFitYByX", "Fit Y by X menu entry must open the creation flow");

assertSourceIncludes(workspaceSource, "fitYByX: fitYByXItems", "Project save payload must include Fit Y by X analyses");
assertSourceIncludes(workspaceSource, "fitYByXFolders", "Project save/open payloads must include Fit Y by X folder assignments");
assertSourceIncludes(workspaceSource, "loadFitYByXFromProject((result.fitYByX ?? [])", "Project open must load saved Fit Y by X analyses");
assertSourceIncludes(workspaceSource, "resetFitYByX()", "Project close/open reset must clear the Fit Y by X store");

assertSourceIncludes(workspaceSource, "activeFitYByXId", "Workspace must track the active Fit Y by X analysis");
assertSourceIncludes(workspaceSource, "showFitYByXDialog", "Workspace must track the Fit Y by X creation dialog");
assertSourceIncludes(workspaceSource, "addFitYByX", "Workspace must add newly created Fit Y by X analyses");
assertSourceIncludes(workspaceSource, "renameFitYByX", "Workspace must rename Fit Y by X analyses from the tree");
assertSourceIncludes(workspaceSource, "deleteFitYByX", "Workspace must delete Fit Y by X analyses from the tree");
assertSourceIncludes(workspaceSource, "deleteFitYByXByDataset", "Deleting a source table must cascade-delete dependent Fit Y by X analyses");
assertSourceIncludes(workspaceSource, "fsSetFitYByXFolder", "Workspace drag/drop must move Fit Y by X analyses into folders");

assertSourceIncludes(workspaceSource, "| { kind: \"fitYByX\"; id: string }", "Drag payload and context menu unions must include Fit Y by X items");
assertSourceIncludes(workspaceSource, "fitYByXByParent", "Tree grouping must include Fit Y by X documents by folder");
assertSourceIncludes(workspaceSource, "setActiveFitYByXId(null)", "Selecting tables, graphs, tabulates, or closing/opening must clear active Fit Y by X selection");
assertSourceIncludes(workspaceSource, "setActiveFitYByXId(id)", "Selecting or creating a Fit Y by X item must activate it");
assertSourceIncludes(workspaceSource, "activeFitYByXId === item.id", "Tree rows must show the active Fit Y by X document");
assertSourceIncludes(workspaceSource, "sourceDatasetId === id", "Source-table deletion must recognize active dependent Fit Y by X analyses");
assertSourceIncludes(workspaceSource, "history.newFitYByX", "Creation must record Fit Y by X history");
assertSourceIncludes(workspaceSource, "history.renameFitYByX", "Rename must record Fit Y by X history");
assertSourceIncludes(workspaceSource, "history.deleteFitYByX", "Delete must record Fit Y by X history");
assertSourceIncludes(workspaceSource, "<FitYByXView", "Main pane must dispatch to FitYByXView");

const locales = [
  ["en", readJson("../src/i18n/locales/en.json")],
  ["vi", readJson("../src/i18n/locales/vi.json")],
  ["zh-CN", readJson("../src/i18n/locales/zh-CN.json")],
  ["zh-TW", readJson("../src/i18n/locales/zh-TW.json")],
] as const;

const requiredLocalePaths = [
  "menu.fitYByX",
  "fitYByX.title",
  "fitYByX.dialogTitle",
  "fitYByX.response",
  "fitYByX.factor",
  "fitYByX.create",
  "fitYByX.cancel",
  "fitYByX.search",
  "fitYByX.sourceMissing",
  "fitYByX.validation.missingResponse",
  "fitYByX.validation.missingFactor",
  "fitYByX.validation.duplicateRole",
  "fitYByX.validation.invalidResponse",
  "fitYByX.validation.invalidFactor",
  "history.newFitYByX",
  "history.renameFitYByX",
  "history.deleteFitYByX",
  "workspace.fitYByXMissing",
  "workspace.fitYByXSourceMissing",
];

for (const [localeName, messages] of locales) {
  for (const keyPath of requiredLocalePaths) {
    assert.equal(typeof getPathValue(messages, keyPath), "string", `${localeName} locale must define ${keyPath}`);
  }
}

console.log("Workspace Fit Y by X integration contract passed");