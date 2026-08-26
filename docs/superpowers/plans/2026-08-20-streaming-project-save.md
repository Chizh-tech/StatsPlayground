# Streaming Project Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Save every project through one bounded-memory streaming archive pipeline while keeping the UI browsable, blocking mutations consistently, and reporting accurate progress.

**Architecture:** A `SaveCoordinator` grants mutation permits during normal operation and acquires an exclusive RAII save guard after draining active mutations. The async save command captures stable metadata, reads DuckDB rows with keyset batches, incrementally writes the existing v3 JSON entries into a temporary ZIP, validates and flushes it, then atomically replaces the destination. Frontend state becomes globally read-only during this operation while read queries and navigation remain available.

**Tech Stack:** Rust 2021, DuckDB 1.10505, Tauri 2.10 channels, zip 2, serde/serde_json streaming APIs, Windows atomic replacement APIs where required, React 19, Zustand 5, TypeScript 5.7.

## Global Constraints

- One streaming save pipeline handles empty, small, and large projects.
- Existing `.spprj` and embedded `.sptb` v3 JSON shapes, entry names, scalar tags, BLOB hex, and complex-value encoding remain byte-semantically compatible.
- A save never materializes complete `TableDoc.rows` and complete serialized table bytes simultaneously.
- Save runs outside the Tauri main command thread.
- The project is browsable but read-only while saving; backend coordination is authoritative.
- Save startup waits for active mutations and blocks new mutations without a TOCTOU gap.
- Read-only queries remain available between bounded save batches.
- Save As changes project identity only after successful archive validation and placement.
- Failure preserves the previous file, leaves dirty set, removes recoverable temporary files, and exits read-only state.
- Progress transitions are ordered; regular events occur in the 100-250 ms window while work advances.
- The current project format is not changed.
- Reference spec: `docs/superpowers/specs/2026-08-20-graph-save-large-data-performance-design.md`.

## File Structure

### New Files

- `src-tauri/src/services/save_coordinator.rs`: mutation permits, exclusive save guard, active-writer drain, and status tests.
- `src-tauri/src/services/archive_cell.rs`: shared archive cell serializer for scalar, tagged complex, null, and BLOB values.
- `src-tauri/src/services/streaming_project_writer.rs`: keyset batch reader, incremental table-entry writer, progress throttle, validation, cleanup, and atomic placement.
- `src-tauri/src/models/save.rs`: one request model, progress phase/event, and captured-save metadata.
- `src/utils/saveReadOnly.ts`: pure frontend read-only predicates and state transition helpers.
- `tests/saveReadOnly.test.ts`: dirty, progress, read-only, and failure transition regressions.

### Modified Files

- `src-tauri/src/state.rs`: own `SaveCoordinator`.
- `src-tauri/src/error.rs`: add explicit `Busy`, `ReadOnly`, and save-related error variants while preserving string serialization.
- `src-tauri/src/models/mod.rs`, `src-tauri/src/services/mod.rs`: register new modules.
- `src-tauri/src/services/project_service.rs`: capture metadata, delegate streaming save, commit Save As identity after success.
- `src-tauri/src/services/spprj_archive.rs`: expose shared manifest/entry helpers and remove complete-table serialization from project save.
- `src-tauri/src/commands/project_commands.rs`: one async request plus progress channel.
- `src-tauri/src/commands/data_commands.rs`, `table_commands.rs`, `io_commands.rs`, `history_commands.rs`: acquire mutation permits for mutating operations.
- `src/services/projectService.ts`, `src/stores/useProjectStore.ts`, `src/components/Workspace.tsx`: progress channel and global read-only lifecycle.
- `src/components/DataTableView.tsx`, `src/components/graphBuilder/GraphBuilderView.tsx`, `src/components/tabulate/TabulateView.tsx`, `src/components/HistoryPanel.tsx`, `src/components/ManageExtrasDialog.tsx`, `src/components/NewTableDialog.tsx`, `src/components/SqlQueryDialog.tsx`, and `src/components/TableOpsDialog.tsx`: disable frontend mutation entry points while saving.
- `src/stores/useGraphBuilderStore.ts`, `src/stores/useGraphPaletteStore.ts`, `src/stores/useHistoryStore.ts`, `src/stores/useFolderStore.ts`, and `src/stores/useTabulateStore.ts`: reject frontend-only state mutations while saving.
- `src/i18n/locales/{en,vi,zh-CN,zh-TW}.json`: save phases, read-only message, and failure text.
- `src-tauri/src/perf_harness.rs`, `src-tauri/examples/performance_baseline.rs`, `docs/performance.md`: save baseline and optimized reports.

---

### Task 1: Add Current Save Baselines And Failure Fixtures

**Files:**
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `docs/performance.md`

**Interfaces:**
- Produces: performance operation `save_current` reporting `rows`, `columns`, `operationMs`, `archiveBytes`, and `resultRows`.
- Produces: reusable test fixture `seed_save_project(state, rows, columns)`.

- [ ] **Step 1: Write the failing performance test**

```rust
#[test]
fn performance_cli_measures_current_project_save() {
    let report = execute(Options {
        rows: 300_000,
        columns: 20,
        operation: Operation::SaveCurrent,
    })
    .unwrap();

    assert_eq!(report.result_rows, 300_000);
    assert!(report.archive_bytes > 0);
}
```

- [ ] **Step 2: Run and verify the red state**

Run: `cargo test --manifest-path src-tauri/Cargo.toml performance_cli_measures_current_project_save -- --nocapture`

Expected: missing enum variant and report field.

- [ ] **Step 3: Implement a baseline around the existing save path**

Seed a project using existing helpers, call the current `ProjectService::save_project`, measure wall time and output size, and delete only the temporary benchmark archive afterward. Do not call the future streaming writer.

- [ ] **Step 4: Add preservation and failure fixtures**

Extend project-service tests with a multi-type table containing null, BLOB, decimal, timestamp, list, and struct values. Reopen the output and assert values, display properties, graph metadata, folders, history, and snapshots. Add a fixture that begins with a valid destination archive and verifies an injected write failure leaves its bytes unchanged.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml performance_cli_measures_current_project_save -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::project_service::tests -- --nocapture
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation save_current
```

Record wall time and peak working set in `docs/performance.md`.

Commit:

```powershell
git add src-tauri/src/perf_harness.rs src-tauri/src/services/project_service.rs docs/performance.md
git commit -m "test(project): baseline large project saves"
```

---

### Task 2: Implement Race-Free Save Coordination

**Files:**
- Create: `src-tauri/src/services/save_coordinator.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/error.rs`

**Interfaces:**
- Produces: `SaveCoordinator::mutation_permit() -> Result<MutationPermit<'_>, AppError>`.
- Produces: `SaveCoordinator::begin_save() -> Result<SaveGuard<'_>, AppError>`.
- Produces: `SaveCoordinator::is_saving() -> bool`.

- [ ] **Step 1: Write failing concurrency tests**

Use barriers and threads to assert:

```rust
let permit = coordinator.mutation_permit().unwrap();
let save = std::thread::spawn(move || coordinator_for_thread.begin_save());
assert!(!save.is_finished());
drop(permit);
assert!(save.join().unwrap().is_ok());
```

Also assert a second save returns `AppError::Busy`, no new mutation permit starts after save intent is registered, and dropping `SaveGuard` restores permit acquisition after success and error paths.

- [ ] **Step 2: Run and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::save_coordinator::tests -- --nocapture`

Expected: module and error variants are missing.

- [ ] **Step 3: Implement coordinator state and RAII guards**

Use `Mutex<CoordinatorState>` plus `Condvar`:

```rust
struct CoordinatorState {
    saving: bool,
    save_waiting: bool,
    active_mutations: usize,
}
```

`begin_save` sets `save_waiting`, rejects concurrent saves, waits until `active_mutations == 0`, then sets `saving`. `mutation_permit` rejects while either `save_waiting` or `saving`. Guard drops update counts and notify waiters.

- [ ] **Step 4: Add coordinator to AppState and explicit errors**

Initialize `save_coordinator` in every `AppState::new`. Add `AppError::Busy(String)` and `AppError::ReadOnly(String)` with existing string serialization; do not broaden the frontend error wire in this task.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::save_coordinator::tests -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
```

Commit:

```powershell
git add src-tauri/src/services/save_coordinator.rs src-tauri/src/services/mod.rs src-tauri/src/state.rs src-tauri/src/error.rs
git commit -m "feat(project): coordinate saves and mutations"
```

---

### Task 3: Share One Archive Cell Encoder

**Files:**
- Create: `src-tauri/src/services/archive_cell.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`

**Interfaces:**
- Produces: `write_archive_cell<W: Write>(writer: &mut W, value: &duckdb::types::Value, column_type: &str) -> Result<(), AppError>`.
- Produces: `archive_cell_to_json(value, column_type) -> Result<serde_json::Value, AppError>` only for compatibility callers that still require a JSON value.

- [ ] **Step 1: Write compatibility tests before extraction**

Parameterize null, bool, signed/unsigned integer, float, text escaping, BLOB hex, decimal, date/time/timestamp, list, array, map, struct, union, UUID, and enum values. Assert the direct writer bytes parse to the same JSON value currently produced by `compose_table_doc`.

- [ ] **Step 2: Run tests and verify the missing API**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::archive_cell::tests -- --nocapture`

Expected: module/API missing.

- [ ] **Step 3: Extract the existing archive encoding rules**

Move archive scalar detection, tagged complex encoding, byte-to-hex handling, and JSON escaping into `archive_cell.rs`. Use `serde_json::Serializer` or `serde_json::to_writer` for each bounded value; do not hand-escape strings.

- [ ] **Step 4: Make existing compose/export callers use the shared encoder**

Replace duplicate conversions in project compose and standalone `.sptb` export. Keep current JSON fixtures unchanged.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::archive_cell::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::project_service::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::spprj_archive::tests -- --nocapture
```

Commit:

```powershell
git add src-tauri/src/services/archive_cell.rs src-tauri/src/services/mod.rs src-tauri/src/services/project_service.rs src-tauri/src/services/spprj_archive.rs
git commit -m "refactor(project): share archive cell encoding"
```

---

### Task 4: Stream V3 Table Entries With Bounded Keyset Batches

**Files:**
- Create: `src-tauri/src/models/save.rs`
- Create: `src-tauri/src/services/streaming_project_writer.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`

**Interfaces:**
- Consumes: `SaveGuard` and shared archive cell encoder.
- Produces: `StreamingProjectWriter::write(&SaveSnapshot, &Path, progress_cb) -> Result<SaveWriteResult, AppError>`.
- Produces: `SaveProgress` and `SavePhase` models.

Define the internal and wire models with these fixed fields:

```rust
#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveProjectRequest {
    pub file_path: Option<String>,
    pub history: Vec<serde_json::Value>,
    pub snapshots: Vec<serde_json::Value>,
    pub graph_builders: Vec<serde_json::Value>,
    pub tabulates: Vec<serde_json::Value>,
    pub folders: Vec<String>,
    pub table_folders: std::collections::HashMap<String, String>,
    pub graph_folders: std::collections::HashMap<String, String>,
    pub tabulate_folders: std::collections::HashMap<String, String>,
}

pub struct SaveSnapshot {
    pub current_project: ProjectInfo,
    pub destination_path: std::path::PathBuf,
    pub destination_name: String,
    pub datasets: Vec<DatasetMeta>,
    pub column_display: std::collections::HashMap<String, Vec<ColumnDisplayProps>>,
    pub request: SaveProjectRequest,
}

pub struct SaveWriteResult {
    pub archive_bytes: u64,
    pub tables_written: usize,
    pub rows_written: usize,
}

pub type SaveProgressCallback<'a> = dyn Fn(SaveProgress) + Send + Sync + 'a;
```

`SavePhase` serializes as `preparing`, `table`, `metadata`, `compressing`, and
`finalizing`. `SaveProgress` contains `phase`, `table_index`, `table_total`,
optional `table_name`, `rows_done`, `rows_total`, and optional
`overall_progress` using camelCase serialization.

- [ ] **Step 1: Write failing scale and keyset tests**

Run one writer test over `0`, `1`, `10`, `5_000`, and `300_000` rows. Add gapped row IDs such as `1, 2, 8, 1001` and assert reopened order and exact values. Track a test-only maximum batch byte count and assert it stays below 8 MiB.

- [ ] **Step 2: Add failure-injection tests**

Inject failures after table header, between row batches, during ZIP finish, during `sync_all`, during validation, and during replacement. Assert the original destination bytes are unchanged, the temp file is removed when possible, and completion progress is absent.

- [ ] **Step 3: Run and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::streaming_project_writer::tests -- --nocapture`

Expected: writer symbols are missing.

- [ ] **Step 4: Implement keyset batch reads**

Add a DuckDB iterator method that resolves columns once and repeatedly executes:

```sql
SELECT _row_id, <validated user columns>
FROM <validated dataset table>
WHERE _row_id > ?
ORDER BY _row_id ASC
LIMIT ?
```

Acquire the DB mutex only while filling a bounded batch. Release it before JSON serialization and ZIP writes. Start with a 4 MiB target and hard 8 MiB cap.

- [ ] **Step 5: Implement incremental table JSON and archive entries**

Write the existing table object metadata and opening `"rows":[`. Serialize comma-separated rows with `write_archive_cell`, then close the array/object. Reuse existing manifest and stable `tables/<id>.sptb` entry naming. Do not construct `TableDoc.rows` or call `serde_json::to_vec` on a complete table.

- [ ] **Step 6: Implement flush, validation, and atomic placement**

Finish ZIP, call `sync_all`, reopen the temporary archive, validate the manifest and expected entries, then atomically place it. On Windows use a replacement API with replace-existing semantics; do not delete the destination before placement. On other platforms use same-directory rename semantics.

- [ ] **Step 7: Implement progress throttling**

Emit mandatory phase transitions and completion. While rows advance, emit no faster than 100 ms and ensure a progress event at least every 250 ms. Calculate row totals before writing without scanning user values.

- [ ] **Step 8: Verify and commit**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::streaming_project_writer::tests -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
```

Commit:

```powershell
git add src-tauri/src/models/save.rs src-tauri/src/models/mod.rs src-tauri/src/services/streaming_project_writer.rs src-tauri/src/services/mod.rs src-tauri/src/services/spprj_archive.rs src-tauri/src/engine/duckdb_engine.rs
git commit -m "feat(project): stream project archives in bounded batches"
```

---

### Task 5: Wire One Async Save Command And Commit Save As Identity Safely

**Files:**
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/commands/project_commands.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src/services/projectService.ts`

**Interfaces:**
- Consumes: `SaveProjectRequest`, `SaveProgress`, `StreamingProjectWriter`, and `SaveGuard`.
- Produces: `save_project(request, on_progress) -> Result<ProjectInfo, AppError>`.

- [ ] **Step 1: Write failing command and Save As tests**

Assert source text uses `#[tauri::command(async)]` and one request object plus `Channel<SaveProgress>`. Add service tests proving failed Save As preserves the old path/name and successful Save As updates both only after the new file opens successfully.

- [ ] **Step 2: Run and verify failure**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::project_commands::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::project_service::tests::save_as -- --nocapture
```

Expected: old synchronous loose-argument command fails assertions.

- [ ] **Step 3: Capture a stable SaveSnapshot under SaveGuard**

Begin save before reading mutable metadata. Capture project identity, dataset list/generations, graph builders, tabulates, folders, history, snapshots, and column display properties. Delegate to the writer. Do not update `AppState.project` before success.

- [ ] **Step 4: Emit progress through Tauri Channel**

Use `Channel<SaveProgress>` and ignore send failures. Return `ProjectInfo` only after atomic placement and Save As identity commit. Let RAII clear save state on every return path.

- [ ] **Step 5: Update TS service contract**

Create one camelCase request object and `Channel<SaveProgress>`. The service method accepts an `onProgress` callback and returns `ProjectInfo`.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::project_commands::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::project_service::tests -- --nocapture
npx tsc -b --pretty false
```

Commit:

```powershell
git add src-tauri/src/services/project_service.rs src-tauri/src/commands/project_commands.rs src-tauri/src/lib.rs src/services/projectService.ts
git commit -m "feat(project): save projects asynchronously with progress"
```

---

### Task 6: Guard Every Backend Mutation Family

**Files:**
- Modify: `src-tauri/src/commands/data_commands.rs`
- Modify: `src-tauri/src/commands/table_commands.rs`
- Modify: `src-tauri/src/commands/io_commands.rs`
- Modify: `src-tauri/src/commands/history_commands.rs`
- Modify: `src-tauri/src/commands/project_commands.rs`

**Interfaces:**
- Consumes: `AppState.save_coordinator.mutation_permit()`.
- Produces: command-level permit lifetime covering each complete mutating service operation.

- [ ] **Step 1: Add a command classification test**

Create a test table listing every registered command and classification. Mutating entries include data import/create/delete/rename, row/cell/column changes, paste, change-set apply/drop, display-property writes, all table transformations except `get_columns`, SQLite import, snapshot restore, project init/create/open/import table, and SQL create-table. Read queries and exports are classified read-only.

- [ ] **Step 2: Run and verify uncovered commands fail**

Run: `cargo test --manifest-path src-tauri/Cargo.toml commands::mutation_guard_coverage -- --nocapture`

Expected: mutating commands lack permit markers/helpers.

- [ ] **Step 3: Acquire permits in command handlers**

At the start of every mutating handler:

```rust
let _permit = state.save_coordinator.mutation_permit()?;
```

Hold it until the delegated service call returns. Do not use a bare `is_saving` check. Save acquires `SaveGuard`, not a mutation permit.

- [ ] **Step 4: Add concurrency integration tests**

Start a blocking test save, assert representative commands from every family return `ReadOnly`, and assert table-window query, graph query, stats, export, and current-project reads still succeed.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml commands::mutation_guard_coverage -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::save_coordinator::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml
```

Commit:

```powershell
git add src-tauri/src/commands/data_commands.rs src-tauri/src/commands/table_commands.rs src-tauri/src/commands/io_commands.rs src-tauri/src/commands/history_commands.rs src-tauri/src/commands/project_commands.rs
git commit -m "feat(project): block mutations during project save"
```

---

### Task 7: Add Global Frontend Read-Only Save State And Progress UI

**Files:**
- Create: `src/utils/saveReadOnly.ts`
- Create: `tests/saveReadOnly.test.ts`
- Modify: `src/stores/useProjectStore.ts`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/components/DataTableView.tsx`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/tabulate/TabulateView.tsx`
- Modify: `src/components/HistoryPanel.tsx`
- Modify: `src/components/ManageExtrasDialog.tsx`
- Modify: `src/components/NewTableDialog.tsx`
- Modify: `src/components/SqlQueryDialog.tsx`
- Modify: `src/components/TableOpsDialog.tsx`
- Modify: `src/stores/useGraphBuilderStore.ts`
- Modify: `src/stores/useGraphPaletteStore.ts`
- Modify: `src/stores/useHistoryStore.ts`
- Modify: `src/stores/useFolderStore.ts`
- Modify: `src/stores/useTabulateStore.ts`
- Modify: `src/i18n/locales/{en,vi,zh-CN,zh-TW}.json`

**Interfaces:**
- Consumes: Task 5 progress callback.
- Produces store fields `saving`, `readOnly`, and `saveProgress`; helper `assertProjectMutable(readOnly)`.

- [ ] **Step 1: Write failing pure transition tests**

Test these transitions:

```ts
const started = beginSaveState({ dirty: true });
assert.equal(started.saving, true);
assert.equal(started.readOnly, true);

const failed = failSaveState(started);
assert.equal(failed.dirty, true);
assert.equal(failed.readOnly, false);

const completed = completeSaveState(started);
assert.equal(completed.dirty, false);
assert.equal(completed.readOnly, false);
```

Also test monotonic progress replacement and duplicate-save rejection.

- [ ] **Step 2: Run and verify failure**

Run: `node --experimental-strip-types tests/saveReadOnly.test.ts`

Expected: helper module missing.

- [ ] **Step 3: Implement Zustand save lifecycle with finally cleanup**

Set read-only before invoking the service. Update progress from the channel. Clear dirty only after success. Preserve dirty on failure. Always clear `saving`, `readOnly`, and transient progress in `finally`; retain a final error for display.

- [ ] **Step 4: Add a non-modal progress surface**

Show phase, table name, row counts, and overall progress without blocking navigation. Disable save while one is active. Navigation, scrolling, zoom, and read-only queries stay enabled.

- [ ] **Step 5: Guard every frontend mutation entry point**

Disable table editing, imports, schema operations, graph configuration, tabulate/folder/palette mutations, snapshot restore/delete, SQL create-table, drag/drop, and mutation keyboard shortcuts. Each listed store checks `useProjectStore.getState().readOnly` before frontend-only mutations so keyboard and indirect callers cannot bypass disabled controls. Use one shared `readOnly` source; do not duplicate local saving booleans. Keep backend errors as the final authority.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
node --experimental-strip-types tests/saveReadOnly.test.ts
npm run build
```

Manually start a save and verify table scroll, graph navigation, and read-only table-window loads while edit controls are disabled.

Commit:

```powershell
git add src/utils/saveReadOnly.ts tests/saveReadOnly.test.ts src/stores/useProjectStore.ts src/stores/useGraphBuilderStore.ts src/stores/useGraphPaletteStore.ts src/stores/useHistoryStore.ts src/stores/useFolderStore.ts src/stores/useTabulateStore.ts src/components/Workspace.tsx src/components/DataTableView.tsx src/components/graphBuilder/GraphBuilderView.tsx src/components/tabulate/TabulateView.tsx src/components/HistoryPanel.tsx src/components/ManageExtrasDialog.tsx src/components/NewTableDialog.tsx src/components/SqlQueryDialog.tsx src/components/TableOpsDialog.tsx src/i18n/locales/en.json src/i18n/locales/vi.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json
git commit -m "feat(project): keep saves browsable and read-only"
```

---

### Task 8: Remove Complete-Table Save Materialization And Enforce Performance Gates

**Files:**
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src-tauri/src/services/spprj_archive.rs`
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `src-tauri/examples/performance_baseline.rs`
- Modify: `docs/performance.md`

**Interfaces:**
- Consumes: completed streaming writer and coordinator.
- Produces: production save path with no complete project `TableDoc.rows` materialization and release operation `save`.

- [ ] **Step 1: Add a source and allocation regression**

Assert the project save path does not call `compose_table_doc` for each dataset and the project archive writer does not call `serde_json::to_vec(doc)` for table entries. Use a test allocator or writer metrics to assert maximum retained batch bytes stay bounded as row count increases.

- [ ] **Step 2: Run the guard and verify failure before deletion**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::streaming_project_writer::tests::save_path_is_streaming -- --nocapture`

Expected: old materialization call is still detected until removed.

- [ ] **Step 3: Delete the old production save route**

Keep `compose_table_doc` as the standalone `.sptb` export compatibility API. Project save must always call `StreamingProjectWriter`. Remove the old project-save loop that calls `compose_table_doc` and remove duplicate complete-table entry serialization from `write_project_archive` after all remaining callers are migrated.

- [ ] **Step 4: Run the release benchmark and real project check**

Run:

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation save
```

Open the existing 300,000-row project, save it, and record wall time, peak working set, event cadence, read-query latency during save, and UI heartbeat. Reopen the output and compare all project content.

Required gates: additional peak memory below 100 MB, at least 50 percent wall-time improvement from `save_current`, no unresponsive UI, visible progress every 100-250 ms while advancing, and a successful read-only query between batches.

- [ ] **Step 5: Run full verification**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
node --experimental-strip-types tests/saveReadOnly.test.ts
npm run build
```

Run Clippy and distinguish pre-existing repository warnings from new findings:

```powershell
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

- [ ] **Step 6: Record results and commit**

Update `docs/performance.md` with baseline and optimized release measurements and the real `.spprj` validation.

Commit:

```powershell
git add src-tauri/src/services/project_service.rs src-tauri/src/services/spprj_archive.rs src-tauri/src/perf_harness.rs src-tauri/examples/performance_baseline.rs docs/performance.md
git commit -m "perf(project): enforce streaming save targets"
```
