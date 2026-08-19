# Big Data Performance Phase 0-1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Establish repeatable large-table measurements, then replace complete-table WebView loading and complete-table undo snapshots with bounded server-side windows and incremental history.

**Architecture:** Keep the current in-memory DuckDB and existing `query_table` contract temporarily so graph and table-operation callers remain compatible. Add a separate bounded window query with parameterized backend filtering and deterministic ordering, build a framework-independent frontend LRU page cache, migrate `DataTableView` to that contract, then replace its full result snapshots with typed inverse actions. File-backed `.spprj v4` is a separate Phase 2 plan after this bounded-data boundary is stable.

**Tech Stack:** Rust 2021, Tauri v2, DuckDB 1.10505.0, serde, React 19, TypeScript 5.7, Zustand 5, Node test runner.

## Global Constraints

- Reference workload is 100,000 rows by 20 columns; pressure workload is 500,000 rows.
- One table window contains 500 rows by default and no backend request may exceed 2,000 rows.
- One frontend table cache retains no more than 5,000 rows.
- Natural order is `_row_id`; every alternate sort appends `_row_id` as deterministic tie-breaker.
- Filter values are bound parameters; dataset and column identifiers are metadata-validated and quoted.
- Existing `query_table` remains available until all graph, export, and table-operation callers migrate.
- `DataTableView` must not request `pageSize: 1_000_000`, retain the complete managed table, or clone complete table rows into history.
- Stale window responses must be ignored after dataset, filter, sort, or mutation generation changes.
- Rust commands return `Result<T, AppError>` and contain no `unwrap()` or `expect()` outside tests.
- Rust IPC models use camelCase serialization and TypeScript mirrors them exactly.
- Do not modify or revert the original checkout's uncommitted `src-tauri/Cargo.toml`.
- Do not commit or push unless the user explicitly requests it.

---

### Task 1: Deterministic Performance Harness

**Files:**
- Create: `src-tauri/examples/performance_baseline.rs`
- Create: `docs/performance.md`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Test: inline tests in `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Produces: `DuckDbEngine::seed_benchmark_table(&self, id: &str, name: &str, rows: usize, columns: usize) -> Result<(), AppError>` under `#[cfg(any(test, feature = "perf-harness"))]` or an equivalent example-local SQL generator.
- Produces: an example accepting `--rows`, `--columns`, and `--operation` with operations `query`, `paste`, and `restore`.
- Produces: phase timings for setup, operation, and total as machine-readable JSON on stdout.

- [ ] **Step 1: Add a failing ignored benchmark smoke test**

Add a test that generates 10,000 rows entirely inside DuckDB, verifies the row and column counts, queries a 500-row window, and asserts only correctness and bounded result size. Mark only timing-oriented tests ignored; the correctness smoke test runs normally.

- [ ] **Step 2: Verify the focused test fails**

Run `cargo test benchmark_fixture_creates_requested_shape -- --exact --nocapture` using its full module path. Expected: compile failure because the fixture does not exist.

- [ ] **Step 3: Implement set-based fixture generation**

Use DuckDB `range()` and generated expressions in one `CREATE TABLE AS SELECT`; do not loop through rows in Rust. Register `_meta_datasets` and `_meta_columns` consistently with normal managed tables.

- [ ] **Step 4: Add the CLI example and documentation**

Document release invocation, output fields, reference workloads, and that absolute timing assertions do not run in normal CI. The example must not expose production-only APIs publicly solely for benchmarking.

- [ ] **Step 5: Verify Task 1**

Run the focused test, `cargo test`, and one release example with 100,000 rows. Record observed timings in `docs/performance.md` as a dated baseline, explicitly labeling the machine and build profile.

---

### Task 2: Bounded Window And Filter Backend

**Files:**
- Modify: `src-tauri/src/models/table.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/services/data_service.rs`
- Modify: `src-tauri/src/commands/data_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Test: inline tests in `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Consumes: existing dataset metadata and internal UUID table names.
- Produces: `TableWindowRequest { dataset_id, start, count, sort, filters, generation }`.
- Produces: `TableWindowResult { columns, column_types, rows, total_rows, start, generation }`.
- Produces: `query_table_window(request) -> Result<TableWindowResult, AppError>` through engine, service, command, registration, and TypeScript IPC.
- Produces filter variants equivalent to the current continuous range, categorical selected values, and date range semantics.

- [ ] **Step 1: Add failing bounded-window tests**

Cover first/middle/final windows, count `0`, count `2001`, start overflow, deterministic sorting with duplicate values, missing-column rejection, categorical empty selection returning zero rows, null handling, and stale generation rejection.

- [ ] **Step 2: Verify the tests fail for missing contract**

Run only the new engine tests and confirm failures are due to missing request/result types and query method.

- [ ] **Step 3: Implement parameterized predicate compilation**

Resolve all column names against `_meta_columns`, quote identifiers, bind values, and preserve current left-to-right filter combination semantics. Do not interpolate values into SQL.

- [ ] **Step 4: Implement bounded deterministic query**

Validate `1 <= count <= 2000`, checked-convert start/count, query total filtered rows, and fetch only the requested window. Natural order is `_row_id`; sorted queries append `_row_id`.

- [ ] **Step 5: Wire IPC without removing legacy query**

Add camelCase Rust/TypeScript types and one Tauri command. Existing `query_table` remains unchanged for non-table-view callers during migration.

- [ ] **Step 6: Verify Task 2**

Run focused tests, full `cargo test`, diagnostics, and `npx vite build`.

---

### Task 3: Bounded Frontend Window Cache

**Files:**
- Create: `src/utils/tableWindowCache.ts`
- Create: `tests/tableWindowCache.test.ts`
- Modify: `src/types/data.ts`
- Modify: `src/services/dataService.ts`

**Interfaces:**
- Consumes: `TableWindowRequest` and `TableWindowResult` from Task 2.
- Produces: `TableWindowCache` with `getRange`, `put`, `invalidateRange`, `clear`, and `retainedRowCount`.
- Cache key includes dataset ID, sort, filters, and generation.
- Capacity is supplied by the caller and tested at 5,000 rows.

- [ ] **Step 1: Add failing cache tests**

Test adjacent-page reuse, LRU eviction below the row cap, generation isolation, partial-range invalidation, and rejection of mismatched response keys.

- [ ] **Step 2: Verify tests fail because the cache module is absent**

Run the repository's existing Node/TypeScript test convention for this one file.

- [ ] **Step 3: Implement a framework-independent cache**

Store bounded pages without React dependencies. Never duplicate row arrays when a result can be referenced safely. Eviction must account for actual retained rows, not page count.

- [ ] **Step 4: Add typed IPC wrapper**

Mirror Rust camelCase types and invoke `query_table_window` with one request object.

- [ ] **Step 5: Verify Task 3**

Run the focused cache test and `npx vite build`.

---

### Task 4: Migrate DataTableView To Windows

**Files:**
- Modify: `src/components/DataTableView.tsx`
- Modify: `src/components/filter/FilterPanel.tsx`
- Modify: `src/types/filter.ts` if required for serialization only
- Test: add pure state/controller tests under `tests/` rather than DOM snapshots

**Interfaces:**
- Consumes: `TableWindowCache` and `dataService.queryTableWindow`.
- Produces: a table viewport controller that maps logical row positions to cached rows and requests missing windows.
- Emits server filter request shapes equivalent to current `FilterRuleItem[]` semantics.

- [ ] **Step 1: Extract and test viewport request calculation**

Given logical row count, row height, scroll top, viewport height, and overscan, assert bounded request ranges at start, middle, and end. Assert rapid request replacement ignores stale generations.

- [ ] **Step 2: Replace complete-table load**

Remove the one-million-row request. Initial load fetches one 500-row window. Scroll fetches missing aligned windows and keeps at most 5,000 rows.

- [ ] **Step 3: Move filters and sort to request state**

Changing filters or sort clears the cache, increments the frontend query generation, resets scroll, and fetches the first window. Preserve current filter combination semantics.

- [ ] **Step 4: Migrate editing and selection mappings**

Use `_row_id` from loaded windows. Range selection stores logical ranges, not one key per cell. Operations requiring unloaded rows call backend range commands or explicitly request required bounded windows.

- [ ] **Step 5: Remove accidental full-row consumers**

Type compatibility and overwrite checks use backend mutation responses or bounded range checks. Copying the visible selection may fetch bounded chunks; whole-column/table copy routes to streaming export and is not implemented by expanding JS arrays.

- [ ] **Step 6: Verify Task 4**

Run focused controller tests, `npx vite build`, and manual Playwright checks for 100,000 rows: first render, page boundary scrolling, edit, sort, filter, and stale-response replacement.

---

### Task 5: Incremental DataTable History

**Status:** Complete. Cell, paste, row, and schema operation history are implemented; the full test suite, 100,000-row benchmark, and Tauri smoke validation pass.

**Files:**
- Modify: `src/stores/useHistoryStore.ts`
- Modify: `src/types/history.ts`
- Modify: `src/components/DataTableView.tsx`
- Modify backend data command models only where before-images are required
- Test: add history reducer/controller tests under `tests/` and Rust tests for atomic before-images

**Interfaces:**
- Replaces `afterState.data: TableQueryResult` for DataTable actions with typed inverse operations.
- Produces inverse actions for cell edits, row changes, paste, and schema operations.
- Large paste before-images are referenced by opaque backend change-set IDs.

- [x] **Step 1: Add failing incremental-history tests**

Assert a cell edit stores only row ID, column, old value, and new value. Assert a 100,000-row table does not appear in a normal history entry. Test undo/redo order and history-budget eviction.

- [x] **Step 2: Implement typed history entries**

Keep non-table workspace history compatible, but stop `DataTableView` from calling `structuredClone` on table results.

- [x] **Step 3: Add backend paste before-images**

Capture affected values in a transaction-owned internal table, return a change-set ID, and restore/drop it atomically during undo or eviction.

- [x] **Step 4: Migrate table action call sites**

Cell, row, paste, and schema actions record compact inverse operations and invalidate affected cache ranges after undo/redo.

- [x] **Step 5: Verify Task 5 and Phase 1**

Run all frontend tests, `npx vite build`, full `cargo test`, the 100,000-row release benchmark, and a Tauri smoke test. Confirm frontend retained rows never exceed 5,000 and ordinary history entries do not scale with dataset size.

---

## Phase Exit Criteria

Phase 0-1 is complete only when `DataTableView` no longer contains a managed-table full-row request or full-table `structuredClone`, the bounded-window and incremental-history tests pass, Rust and frontend builds pass, and the recorded 100,000-row benchmark satisfies or explains any missed target with phase timing evidence.
