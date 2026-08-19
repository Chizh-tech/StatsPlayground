# CSV Import Row Identity Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make imported CSV datasets immediately readable through bounded windows and serializable into project files.

**Architecture:** Restore the invariant that every live dataset table begins with a stable internal `_row_id`. Generate that identity during CSV CTAS, leave user-column metadata unchanged, and expose window-load errors in the table UI instead of fabricating an empty result.

**Tech Stack:** Rust 2021, DuckDB, Tauri v2, React 19, TypeScript 5.7.

## Global Constraints

- Work only in `StatsPlayground-big-data-performance`.
- Do not commit or push.
- Keep `_row_id` out of `_meta_columns` and `DatasetMeta.col_count`.
- Keep SQL values parameterized and identifiers generated only from internal UUIDs.

---

### Task 1: Restore CSV Row Identity

**Files:**
- Modify and test: `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Consumes: `DuckDbEngine::import_csv` and `DuckDbEngine::query_table_window`.
- Produces: imported tables whose first physical column is `_row_id BIGINT` with values `1..=row_count`.

- [ ] **Step 1: Write the failing import-window regression**

Create a temporary two-row CSV in the existing engine test module, call
`import_csv`, then assert `col_count == 2`, window columns are
`["_row_id", "name", "amount"]`, and row IDs are `1` and `2`. Remove the
temporary file before the assertion phase completes.

- [ ] **Step 2: Verify RED**

Run:
`cargo test imported_csv_supports_bounded_windows_with_stable_row_ids -- --nocapture`

Expected: FAIL because `query_table_window` cannot bind `_row_id`.

- [ ] **Step 3: Implement the minimal import fix**

Change CSV CTAS to:

```sql
CREATE TABLE "dataset_<uuid>" AS
SELECT ROW_NUMBER() OVER () AS "_row_id", __csv__.*
FROM read_csv($1, auto_detect=true) AS __csv__
```

Keep the information-schema metadata loop, but skip `_row_id` and assign
contiguous visible `col_index` values.

- [ ] **Step 4: Verify GREEN**

Rerun the focused test and require PASS.

---

### Task 2: Prove Imported Tables Can Be Saved

**Files:**
- Modify and test: `src-tauri/src/services/project_service.rs`

**Interfaces:**
- Consumes: fixed `DuckDbEngine::import_csv`.
- Produces: `ProjectService::compose_table_doc` output retaining `_row_id` in each saved row.

- [ ] **Step 1: Write the project serialization regression**

Import a temporary CSV into `AppState`, compose its `TableDoc`, and assert two
visible columns plus exact rows `[1, "alpha", 10]` and `[2, "beta", 20]`.

- [ ] **Step 2: Run the focused project-service test**

Run:
`cargo test imported_csv_composes_into_project_table_document -- --nocapture`

Expected after Task 1: PASS, proving the original save query now works.

---

### Task 3: Surface Initial Window Load Failures

**Files:**
- Modify: `src/components/DataTableView.tsx`

**Interfaces:**
- Consumes: errors from `dataService.getDatasetGeneration` and `queryTableWindow`.
- Produces: visible `errorMsg` state while preserving `data === null` instead of setting an empty table result.

- [ ] **Step 1: Change the load error branch**

On the current request epoch, call `setErrorMsg(String(error))` and do not call
`setData` with empty columns/rows. Preserve console logging for diagnostics.

- [ ] **Step 2: Verify frontend types and production build**

Run: `npm run build`

Expected: TypeScript and Vite build PASS.

---

### Task 4: Full Verification

**Files:**
- No production edits expected.

- [ ] **Step 1: Run all Rust tests**

Run: `cargo test` from `src-tauri`.

Expected: all tests PASS.

- [ ] **Step 2: Run bounded-window frontend regressions**

Run the history timeline, table window cache, and table viewport TS scripts.

- [ ] **Step 3: Rebuild and launch the app**

Start Tauri with explicit `npm --prefix` rooted at the performance worktree,
re-import `StatsPlayground_300k_test.csv`, confirm 12 visible columns and data,
then save a `.spprj` test project successfully.