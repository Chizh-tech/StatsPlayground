import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
  const cleanStarted = beginSaveState({ dirty: false, saving: false, readOnly: false, saveProgress: null });
  const failed = failSaveState(cleanStarted);
  assert.equal(failed.dirty, false);
  assert.equal(failed.readOnly, false);
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

  const compressing: SaveProgress = {
    ...current,
    phase: "compressing",
    rowsDone: 0,
    rowsTotal: 0,
    overallProgress: 1,
  };
  const finalizing: SaveProgress = {
    ...compressing,
    phase: "finalizing",
    overallProgress: undefined,
  };
  assert.equal(replaceSaveProgress(compressing, finalizing).phase, "finalizing");
}

{
  assert.throws(
    () => beginSaveState({ dirty: true, saving: true, readOnly: true, saveProgress: null }),
    /already in progress/i,
  );
}

{
  const source = readFileSync(new URL("../src/components/DataTableView.tsx", import.meta.url), "utf8");
  const resizeStart = source.split("const handleResizeStart")[1]?.split("const autoFitColumn")[0] ?? "";
  const resizeDoubleClick = source.split("const handleResizeDoubleClick")[1]?.split("// ---- Columns panel")[0] ?? "";

  assert.match(resizeStart, /^\s*= \(e: React\.MouseEvent, colIdx: number\) => \{\s*if \(readOnly\) return;/);
  assert.match(resizeStart, /const onMouseMove = \(ev: MouseEvent\) => \{\s*if \(readOnlyRef\.current\) return;/);
  assert.match(resizeStart, /const onMouseUp = \(\) => \{\s*const completedResize = resizingRef\.current;\s*resizingRef\.current = null;[\s\S]*?if \(!completedResize \|\| readOnlyRef\.current\) return;/);
  assert.match(resizeDoubleClick, /^\s*= \(e: React\.MouseEvent, colIdx: number\) => \{\s*if \(readOnly\) return;/);
  assert.match(source, /useEffect\(\(\) => \{\s*if \(!readOnly\) return;\s*const activeResize = resizingRef\.current;[\s\S]*?next\[activeResize\.colIdx\] = activeResize\.startW;[\s\S]*?\}, \[readOnly\]\);/);
  assert.match(source, /onMouseDown=\{readOnly \? undefined : \(e\) => handleResizeStart\(e, ci\)\}/);
  assert.match(source, /onDoubleClick=\{readOnly \? undefined : \(e\) => handleResizeDoubleClick\(e, ci\)\}/);
}

console.log("save-read-only transitions passed");
