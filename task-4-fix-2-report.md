# Task 4 Fix Round 2 Report

## Status

Completed.

Minimum symmetric lifecycle wiring was added so Fit Y by X state is reset on project close/open preflight and restored from project data on open. Folder restoration continues to use the saved `fitYByXFolders` payload after the Fit Y by X items are loaded, so prune sees valid restored IDs.

## Commit

Pending local commit with message:

`fix(project): restore Fit Y by X state on open`

## Tests

- `npx tsx --tsconfig tsconfig.app.json tests/useProjectStore.saveLifecycle.test.ts`
- `npx tsc -b`
- `npx vite build`

## Concerns

- Direct `npx tsx tests/useProjectStore.saveLifecycle.test.ts` does not work in this repo because the test transitively imports `@/` aliases from app code. The validated command above uses `--tsconfig tsconfig.app.json` so the alias resolves correctly.
- `npx vite build` passes with existing chunk-size and mixed static/dynamic import warnings unrelated to this change.

---

## Task 4 Fix Round 3 (issue-80-project-file-layout)

### Status

Completed.

Implemented all requested review follow-ups:

- Routed SQL query result-table creation and Manage Extras export-table creation through one shared project-name resolver in `src/utils/projectFileNaming.ts`, including case-insensitive `.sptb` collision allocation and explicit invalid-name messages.
- Hardened Workspace async dataset rename submit so blur/Enter rename failures from backend are caught, surfaced through existing alert pattern, and do not leave an unhandled async path.
- Tightened Rust reserved-name semantics to evaluate the stem before first dot, so names like `CON.txt` and `LPT9.log` are treated as invalid reserved stems.
- Added tests for extension stripping to empty basename and source/integration contract coverage for shared naming utility usage across all table-creation entry points touched in this task.

### Commit

Pending local commit for this round.

### Tests

- `npx --yes tsx tests/projectFileNaming.test.ts` -> pass
- `npx --yes tsx tests/projectFileNaming.integration.test.ts` -> pass
- `npx --yes tsx tests/workspaceRenameFailure.test.ts` -> pass
- `cargo test build_bundle_rejects_windows_reserved_and_control_character_names` (in `src-tauri/`) -> pass
- `cargo test legacy_open_normalizes_all_visible_document_names_and_marks_requires_migration` (in `src-tauri/`) -> pass
- `npx vite build 2>&1 | Select-Object -Last 3` -> pass

### Concerns

- Rust verification here is targeted to affected semantics and migration behavior; full `cargo test` suite was not run in this round.
- Existing Rust warnings and frontend bundle-size warnings remain pre-existing and unrelated to this fix scope.