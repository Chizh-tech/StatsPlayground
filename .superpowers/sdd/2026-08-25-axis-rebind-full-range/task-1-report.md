Status: DONE

Task: Task 1: Reset Axis Range On Binding Change
Branch: feature/streaming-project-save
Base commit: d83edfa

RED phase 1:
- Added tests/axisBinding.test.ts importing src/components/graphBuilder/axisBinding.ts before the helper existed.
- Ran node --experimental-strip-types tests/axisBinding.test.ts.
- Observed expected ERR_MODULE_NOT_FOUND for src/components/graphBuilder/axisBinding.ts.

GREEN phase 1:
- Created src/components/graphBuilder/axisBinding.ts.
- Implemented prepareAxisBinding(previousFieldName, nextFieldName, hadMulti, axisConfig).
- Behavior: bindingChanged = hadMulti || previousFieldName !== nextFieldName.
- On changed bindings, strips only min, max, and tickInterval; returns undefined if no display fields remain; preserves exact object identity when unchanged.
- Re-ran node --experimental-strip-types tests/axisBinding.test.ts and observed pass.

RED phase 2:
- Extended tests/axisBinding.test.ts with source-level GraphBuilderView wiring assertions.
- Required assertion: prepareAxisBinding(prevField?.name, field.name, hadMulti, prevAxis).
- Ran node --experimental-strip-types tests/axisBinding.test.ts.
- Observed expected AssertionError because GraphBuilderView.tsx was not yet wired to the helper.

GREEN phase 2:
- Modified src/components/graphBuilder/GraphBuilderView.tsx only in bindFieldToSlot.
- Imported prepareAxisBinding from ./axisBinding.
- Replaced the ad hoc fieldChanged/needsAxisReset logic with helper output.
- X/Y binding changes now atomically update encoding, clear multi mode on that slot, and write the returned xAxis/yAxis config.
- Non-axis and unchanged-binding behavior still follows the existing setEncoding path.
- Re-ran node --experimental-strip-types tests/axisBinding.test.ts and observed pass.

Files changed:
- src/components/graphBuilder/axisBinding.ts
- src/components/graphBuilder/GraphBuilderView.tsx
- tests/axisBinding.test.ts

Verification:
- node --experimental-strip-types tests/axisBinding.test.ts
- node --experimental-strip-types tests/scatterProgressive.test.ts
- node --experimental-strip-types tests/graphAnimation.test.ts
- node --experimental-strip-types tests/graphTableDataCache.test.ts
- node --experimental-strip-types tests/loadGraphTableData.test.ts
- npx tsc -b
- npx vite build
- git diff --check

Verification result:
- All listed commands exited 0.

Commit:
- fix(graph): reset range on axis rebind

Self-review:
- Scope stayed limited to the helper, its direct source-regression test, and bindFieldToSlot.
- The helper removes only data-dependent range fields and preserves display-only axis settings exactly as required.
- Same-field drops preserve config identity and continue to skip the atomic update path.

Concerns:
- None.

Fix Round 1:
- Strengthened tests/axisBinding.test.ts so the source assertion now checks the bindFieldToSlot atomic update payload itself, including encoding, axis writeback, and multi cleanup.