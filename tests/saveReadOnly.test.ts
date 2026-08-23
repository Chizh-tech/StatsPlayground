import assert from "node:assert/strict";

import {
  beginSaveState,
  completeSaveState,
  failSaveState,
  replaceSaveProgress,
} from "../src/utils/saveReadOnly.ts";
import type { SaveProgress } from "../src/services/projectService";

{
  const started = beginSaveState({ dirty: true, saving: false, readOnly: false, saveProgress: null });
  assert.equal(started.saving, true);
  assert.equal(started.readOnly, true);

  const failed = failSaveState(started);
  assert.equal(failed.dirty, true);
  assert.equal(failed.readOnly, false);

  const completed = completeSaveState(started);
  assert.equal(completed.dirty, false);
  assert.equal(completed.readOnly, false);
}

{
  const current: SaveProgress = {
    phase: "table",
    tableIndex: 1,
    tableTotal: 5,
    tableName: "A",
    rowsDone: 100,
    rowsTotal: 1000,
    overallProgress: 0.3,
  };
  const stale: SaveProgress = {
    phase: "table",
    tableIndex: 0,
    tableTotal: 5,
    tableName: "A",
    rowsDone: 10,
    rowsTotal: 1000,
    overallProgress: 0.1,
  };
  const next = replaceSaveProgress(current, stale);
  assert.equal(next.rowsDone, 100);
  assert.equal(next.overallProgress, 0.3);

  const advanced: SaveProgress = {
    ...current,
    rowsDone: 400,
    overallProgress: 0.7,
  };
  const replaced = replaceSaveProgress(current, advanced);
  assert.equal(replaced.rowsDone, 400);
  assert.equal(replaced.overallProgress, 0.7);
}

{
  assert.throws(
    () => beginSaveState({ dirty: true, saving: true, readOnly: true, saveProgress: null }),
    /already in progress/i,
  );
}

console.log("save-read-only transitions passed");
