# Task 2 Report: Graph Builder Loading Progress Presentation

## Status
Completed and committed.

## Files Changed
1. tests/loadGraphTableData.test.ts
2. src/components/graphBuilder/GraphBuilderView.tsx
3. src/components/graphBuilder/graphBuilder.css
4. src/i18n/locales/en.json
5. src/i18n/locales/vi.json
6. src/i18n/locales/zh-CN.json
7. src/i18n/locales/zh-TW.json

## Commit
- Commit hash: dcab3b82cd58ac0d4805780bf7b0f786615a86e7
- Commit message: feat(graph): show table loading progress

## Exact RED Evidence
Command:
`node --experimental-strip-types tests/loadGraphTableData.test.ts`

Observed failure before implementation:
- `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /setLoadProgress\(null\)/.`
- Failing line in test: `assert.match(source, /setLoadProgress\(null\)/);`

This confirmed the view had not yet integrated Task 1 progress callback/state.

## GREEN + Build Evidence
Pre-commit verification (final passing run):
1. `node --experimental-strip-types tests/loadGraphTableData.test.ts`
   - Exit code: 0
   - Output: `cancellable graph table loader passed`
2. `npx tsc -b`
   - Exit code: 0
   - Output: none
3. `npx vite build`
   - Exit code: 0
   - Key output: `vite v6.4.1 building for production...` and `✓ built in 8.45s`
4. `git diff --check`
   - Exit code: 0
   - Output: none

Post-commit verification:
1. `node --experimental-strip-types tests/loadGraphTableData.test.ts`
   - Exit code: 0
   - Output: `cancellable graph table loader passed`
2. `npx tsc -b`
   - Exit code: 0
3. `npx vite build`
   - Exit code: 0
   - Key output: `✓ built in 9.37s`
4. `git diff --check`
   - Exit code: 0
5. `git status --short --branch`
   - Output: `## feature/streaming-project-save...origin/feature/streaming-project-save [ahead 9]`
   - No new implementation changes after commit.

## Self-Review Notes
- Added RED assertions first in source integration test for:
  - `setLoadProgress(null)` reset,
  - `onProgress: setLoadProgress` wiring,
  - progressbar a11y markers (`role="progressbar"`, `aria-valuenow=`),
  - `t("graph.loadingProgress", ...)` localization usage,
  - all four locale `graph.loadingProgress` strings with `{{loaded}}` and `{{total}}`.
- Implemented local `loadProgress` state and reset before each load.
- Wired Task 1 callback directly via `onProgress: setLoadProgress`.
- Implemented determinate/indeterminate accessible progress UI:
  - indeterminate bar before first callback,
  - clamped 0..100 percentage,
  - `aria-valuenow` only for determinate mode,
  - localized row detail with locale-aware number formatting.
- Added only Graph Builder-local CSS layout classes (`gb-loading-status`, `gb-loading-detail`) without changing global progress styles.
- Added exact required translation strings for en/vi/zh-CN/zh-TW.
- One intermediate failure occurred after first implementation (`/aria-valuenow=/` source assertion mismatch due attribute spread); fixed by rendering separate determinate and indeterminate progressbar nodes.

## Concerns
- None functionally blocking.
- Source-test assertion style is intentionally string-pattern based; future JSX refactors around attribute rendering may require updating test regexes while keeping behavior unchanged.

## Fix Round 1 (Task 2 Review)

### Scope
- Address all Important findings from `task-2-review.md`.
- Close the test gap by strengthening source assertions to enforce accessible naming and exact progressbar structure.

### RED Evidence (Before Implementation)
Command:
`node --experimental-strip-types tests/loadGraphTableData.test.ts`

Result:
- Exit code: 1
- Failure:
   - `AssertionError [ERR_ASSERTION]: The input did not match the regular expression /className="sp-progress-bar"\s+role="progressbar"\s+aria-label=\{t\("graph\.loading"\)\}\s+aria-valuemin=\{0\}\s+aria-valuemax=\{100\}\s+aria-valuenow=\{loadPercent \?\? undefined\}/`
   - `tests/loadGraphTableData.test.ts:194:10`

This verified the prior implementation lacked the required accessible, correctly structured progress markup.

### Implementation Notes
- Updated source assertions in `tests/loadGraphTableData.test.ts` to require:
   - outer `.sp-progress-bar` element carrying `role="progressbar"`, `aria-label={t("graph.loading")}`, min/max, and `aria-valuenow={loadPercent ?? undefined}`;
   - inner `.sp-progress-fill` with conditional `.sp-progress-indeterminate` modifier;
   - determinate-only width style.
- Updated loading UI in `src/components/graphBuilder/GraphBuilderView.tsx` to render:
   - one outer `.sp-progress-bar` track with required ARIA semantics;
   - one inner `.sp-progress-fill` element, indeterminate modifier only when `loadPercent === null`;
   - width `${loadPercent}%` only for determinate mode.
- Kept numeric progress detail hidden until `loadProgress` exists and `loadPercent !== null`.
- Preserved cancellation and localization wiring (no changes to loader control flow or translation usage).

### GREEN Evidence (After Implementation)
Commands and results:

1. `node --experimental-strip-types tests/loadGraphTableData.test.ts`
    - Exit code: 0
    - Output: `cancellable graph table loader passed`

2. `npx tsc -b`
    - Exit code: 0
    - Output: none

3. `npx vite build`
    - Exit code: 0
    - Key output:
       - `vite v6.4.1 building for production...`
       - `✓ 969 modules transformed.`
       - `dist/assets/index-BYeZbgLV.js                  2,398.77 kB │ gzip: 732.45 kB`
       - `✓ built in 12.93s`

4. `git diff --check`
    - Exit code: 0
    - Output: none
