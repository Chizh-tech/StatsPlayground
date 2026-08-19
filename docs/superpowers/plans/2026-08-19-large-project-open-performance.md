# Large Project Open Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a 300,000-row project quickly without freezing the desktop window.

**Architecture:** Reuse one prepared typed INSERT statement per restored table inside the existing atomic staging transaction. Run project open asynchronously and forward bounded row progress to the existing overlay.

**Tech Stack:** Rust 2021, DuckDB, Tauri v2, React 19, TypeScript 5.7.

## Global Constraints

- Work only in `StatsPlayground-big-data-performance`.
- Do not commit or push.
- Do not change the `.spprj` or `.sptb` file format.
- Preserve atomic rollback and exact `_row_id` values.

---

### Task 1: Prepared Restore and Row Progress

**Files:**
- Modify and test: `src-tauri/src/services/project_service.rs`

**Interfaces:**
- Preserve: `restore_table_doc(&TableDoc) -> Result<String, AppError>`.
- Add: `restore_table_doc_with_progress(&TableDoc, Option<&dyn Fn(usize, usize)>) -> Result<String, AppError>`.

- [ ] Add a regression restoring 12,001 rows and asserting exact first/last values plus monotonic progress ending at `(12001, 12001)`.
- [ ] Run the focused test and verify RED because the progress-aware method does not exist.
- [ ] Prepare `insert_sql` once before the row loop, reuse the statement, and emit progress every 5,000 rows plus completion.
- [ ] Rerun focused rollback and restore tests.

### Task 2: Responsive Project Open IPC

**Files:**
- Modify: `src-tauri/src/commands/project_commands.rs`
- Modify: `src-tauri/src/services/project_service.rs`
- Modify: `src/components/Workspace.tsx`

**Interfaces:**
- Extend the internal open callback with `rowsDone` and `rowsTotal`.
- Emit the same fields in `open-project-progress`.
- Mark `open_project` with `#[tauri::command(async)]`.

- [ ] Forward per-table restore progress through `ProjectService::open_project`.
- [ ] Update the command payload and frontend listener type/message.
- [ ] Run `cargo check` and `npm run build`.

### Task 3: Real Project Benchmark

**Files:**
- Add a perf-harness example only if needed to invoke `ProjectService::open_project` directly.

- [ ] Run the full Rust suite and frontend regressions.
- [ ] Open `C:\Users\v-zhichuang\OneDrive - Microsoft\Desktop\Untitled Project.spprj` and record elapsed time, peak memory, and responding state.
- [ ] Leave the repaired application running with the project loaded.