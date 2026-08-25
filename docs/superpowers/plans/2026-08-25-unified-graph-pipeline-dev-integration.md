# Unified Graph Pipeline `dev` Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the latest `dev` into `feature/unified-graph-pipeline`, make the typed streaming pipeline Graph Builder's only production data path, and preserve the recently merged progress, lifecycle, axis, and animation behavior.

**Architecture:** Keep `GraphDataRequest -> GraphDataService -> ordered binary chunks -> GraphDataFrame` as the sole graph data path. Resolve conflicts by ownership: the feature branch owns typed graph transport and frame rendering, while latest `dev` owns current project lifecycle, axis reset behavior, animation policy, and unrelated application changes.

**Tech Stack:** Rust 2021, DuckDB 1.10505, Tauri 2.10 channels, TypeScript 5.7, React 19, Zustand 5, ECharts 5.6, Canvas 2D, Node native TypeScript stripping, PowerShell, GitHub CLI.

## Global Constraints

- Full Data remains the default; sampling requires explicit user selection.
- Exact aggregates always use every valid filtered row, including in Sampling mode.
- Do not retain the full-table JSON loader or full-row hot cache as a Graph Builder fallback.
- Request ID and dataset generation guard every asynchronous message and frame commit.
- A cancelled or invalid stream never commits partial data.
- Existing graph project documents remain readable and missing sampling settings default to Full Data.
- Preserve latest `dev` behavior for progress, project lifecycle, axis rebinding, and final 2D/3D no-animation policy.
- Use parameterized SQL values and validated, quoted identifiers.
- Do not change unrelated project-save, table, filter, history, or tabulate behavior.
- Do not add dependencies or change the pinned ECharts package.
- Work only in `C:\Users\v-zhichuang\git\ashton2914\StatsPlayground-unified-graph-pipeline`.
- Do not push until all automated gates and manual acceptance are complete.

## File Ownership

- `src/components/graphBuilder/useGraphDataPipeline.ts`: request cancellation, stream reduction, progress, stale-result fencing, and coherent frame commits.
- `src/components/graphBuilder/GraphBuilderView.tsx`: unified hook integration, progress/error UI, and atomic axis binding updates.
- `src/graphCore/Graph.tsx`: ECharts host plus panel-local Canvas raw points.
- `src/graphCore/Chart3D.tsx`: frame-backed 3D rendering.
- `src/graphCore/transform.ts`: aggregate packet and raw-point descriptor transforms.
- `src-tauri/src/engine/duckdb_engine.rs`: shared save and graph DuckDB primitives.
- `src-tauri/src/perf_harness.rs`: save operations plus `graph_projection`.
- `docs/performance.md`: save and graph evidence in separate sections.
- `src/components/graphBuilder/axisBinding.ts`: latest-`dev` axis reset policy.
- `src/graphCore/animation.ts`: latest-`dev` final render animation policy.

Legacy Graph Builder files are removed after callers are migrated:

```text
src/components/graphBuilder/loadGraphTableData.ts
src/utils/graphTableDataCache.ts
tests/loadGraphTableData.test.ts
tests/graphTableDataCache.test.ts
```

---

### Task 1: Merge Latest `dev` And Reconcile Text Conflicts

**Files:**
- Modify: `docs/performance.md`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/graphCore/Graph.tsx`
- Modify: `src/stores/useGraphBuilderStore.ts`
- Verify: `src-tauri/src/{commands,models,services}/mod.rs`
- Verify: `src-tauri/src/lib.rs`
- Verify: `src/graphCore/Chart3D.tsx`
- Verify: `src/graphCore/transform.ts`
- Verify: `src/i18n/locales/{en,vi,zh-CN,zh-TW}.json`

**Interfaces:**
- Consumes: feature HEAD `d097f702589b2b8ed2a699f2504777988c11067b` and `origin/dev`.
- Produces: one two-parent merge commit containing both project-save and unified-graph behavior.

- [ ] **Step 1: Verify the isolated worktree**

```powershell
git branch --show-current
git status --short --branch
git rev-parse --git-dir
git rev-parse --git-common-dir
```

Expected: `feature/unified-graph-pipeline`, clean status, and a linked worktree.

- [ ] **Step 2: Run the pre-merge graph baseline**

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
node --experimental-strip-types tests/rawPoints.test.ts
node --experimental-strip-types tests/transformAggregatePackets.test.ts
cargo test --manifest-path src-tauri/Cargo.toml models::graph_data::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::graph_data_service::tests -- --nocapture
```

Expected: all pass before integration. Stop if the baseline is red.

- [ ] **Step 3: Start the merge without rewriting history**

```powershell
git fetch origin --prune
git merge --no-ff --no-commit origin/dev
```

Expected conflicts:

```text
docs/performance.md
src-tauri/src/engine/duckdb_engine.rs
src-tauri/src/perf_harness.rs
src/components/graphBuilder/GraphBuilderView.tsx
src/graphCore/Graph.tsx
src/stores/useGraphBuilderStore.ts
```

Inspect any additional conflict before proceeding.

- [ ] **Step 4: Resolve backend conflicts additively**

Keep latest `dev` save, generation, table mutation, and change-set methods together with graph projection and aggregate query methods. In `perf_harness.rs`, preserve all `dev` operations and retain `Operation::GraphProjection`, parser value `graph_projection`, `selected_columns`, `result_rows`, and graph timing. Keep separate save and graph sections in `docs/performance.md`.

- [ ] **Step 5: Resolve frontend conflicts by ownership**

Retain `useGraphDataPipeline`, `GraphDataFrame`, `RawPointsLayer`, and explicit sampling state. Also retain latest `dev` helpers:

```ts
import { prepareAxisBinding } from "./axisBinding";
import { withoutGraphAnimation } from "./animation";
```

Do not restore `loadGraphTableData` or `graphTableDataCache` as the Graph Builder source.

- [ ] **Step 6: Verify auto-merged registrations and locales**

Confirm `src-tauri/src/lib.rs` registers project-save commands plus:

```rust
graph_data_commands::stream_graph_data
graph_data_commands::cancel_graph_data
```

Confirm graph modules remain exported and all four locales retain both branches' required strings.

- [ ] **Step 7: Run the immediate post-merge checks**

```powershell
npx tsc -b --pretty false
cargo test --manifest-path src-tauri/Cargo.toml models::graph_data::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::graph_data_service::tests -- --nocapture
git diff --check
```

Expected: compilation and focused backend tests pass.

- [ ] **Step 8: Commit the merge**

```powershell
git add -A
git commit -m "merge: integrate dev into unified graph pipeline"
```

---

### Task 2: Preserve Axis And Rendering Policies

**Files:**
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/graphCore/Graph.tsx`
- Modify: `src/graphCore/Chart3D.tsx`
- Modify: `src/graphCore/transform.ts`
- Test: `tests/axisBinding.test.ts`
- Test: `tests/graphAnimation.test.ts`
- Test: `tests/scatterProgressive.test.ts`

**Interfaces:**
- Consumes: `prepareAxisBinding(previousFieldName, nextFieldName, hadMulti, axisConfig)` and `withoutGraphAnimation(option)`.
- Produces: atomic axis updates, full 2D/3D no-animation options, and Canvas-only production raw points.

- [ ] **Step 1: Strengthen regressions before production edits**

Require `axisBinding.test.ts` to prove one `updateItem` payload contains new encoding, cleaned axis config, and cleared matching multi slot. Rewrite `scatterProgressive.test.ts` to prove `Graph.tsx` hosts `RawPointsLayer`, `transform.ts` emits frame-backed descriptors, and no production raw-point branch enables ECharts `large` or a legacy raw scatter fallback.

- [ ] **Step 2: Run tests and observe integration failures**

```powershell
node --experimental-strip-types tests/axisBinding.test.ts
node --experimental-strip-types tests/graphAnimation.test.ts
node --experimental-strip-types tests/scatterProgressive.test.ts
```

Expected: at least one discriminating assertion fails if merge resolution omitted a policy.

- [ ] **Step 3: Implement atomic axis updates**

Use:

```ts
const prepared = prepareAxisBinding(
  previousField?.name,
  nextField.name,
  hadMulti,
  previousAxis,
);
```

Write encoding, corresponding axis, and cleared `multiX` or `multiY` in one store update. Preserve state for same-field re-drop without multi replacement.

- [ ] **Step 4: Apply no-animation at final boundaries**

Wrap final full 2D and 3D options with `withoutGraphAnimation`. Do not wrap interaction-only axis patches and do not add staged animation to `RawPointsLayer`.

- [ ] **Step 5: Verify and commit**

```powershell
node --experimental-strip-types tests/axisBinding.test.ts
node --experimental-strip-types tests/graphAnimation.test.ts
node --experimental-strip-types tests/scatterProgressive.test.ts
node --experimental-strip-types tests/rawPoints.test.ts
npx tsc -b --pretty false
git add src/components/graphBuilder/GraphBuilderView.tsx src/graphCore/Graph.tsx src/graphCore/Chart3D.tsx src/graphCore/transform.ts tests/axisBinding.test.ts tests/graphAnimation.test.ts tests/scatterProgressive.test.ts
git commit -m "fix(graph): preserve axis and render policies"
```

---

### Task 3: Adapt Progress And Lifecycle To Stream Frames

**Files:**
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/graphBuilder/graphBuilder.css`
- Modify: `src/stores/useProjectStore.ts`
- Modify: `src/components/Workspace.tsx`
- Test: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Consumes: `processedRows`, `sourceRows`, request ID, generation, and stream indexes.
- Produces: coherent frame state plus monotonic progress and synchronous cancellation fencing.

- [ ] **Step 1: Add failing reducer regressions**

Add assertions that active progress is monotonic, stale completion preserves the old committed frame, cancellation clears pending state but preserves committed state, and zero rows complete coherently. Use actual reducer messages and fixtures.

Define the expected public result:

```ts
export interface GraphLoadProgress {
  processedRows: number;
  sourceRows: number;
  percent: number | null;
}
```

- [ ] **Step 2: Verify the new contract fails**

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
```

Expected: failure because progress or explicit cancellation state is missing.

- [ ] **Step 3: Implement progress without a second data store**

Derive progress in the pipeline reducer/hook. Keep percent `null` until total rows are known, use `100` for coherent zero-row completion, otherwise clamp `processedRows / sourceRows * 100` to `[0, 100]`. Ignore stale regressions. Do not persist progress in Zustand or cache chunks outside pending/committed frame state.

- [ ] **Step 4: Wire accessible UI and lifecycle cancellation**

Keep `role="progressbar"`, ARIA min/max/current values when determinate, and localized processed/source text. Project close/open, dataset deletion, request replacement, and unmount must cancel or fence the active request. Preserve the prior frame on pending and error.

- [ ] **Step 5: Verify and commit**

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
npx tsc -b --pretty false
npm run build
git add src/components/graphBuilder/useGraphDataPipeline.ts src/components/graphBuilder/GraphBuilderView.tsx src/components/graphBuilder/graphBuilder.css src/stores/useProjectStore.ts src/components/Workspace.tsx tests/graphDataPipeline.test.ts
git commit -m "fix(graph): preserve stream progress and lifecycle"
```

---

### Task 4: Remove The Legacy Full-Table Graph Path

**Files:**
- Delete: `src/components/graphBuilder/loadGraphTableData.ts`
- Delete: `src/utils/graphTableDataCache.ts`
- Delete: `tests/loadGraphTableData.test.ts`
- Delete: `tests/graphTableDataCache.test.ts`
- Test: `tests/graphDataPipeline.test.ts`
- Test: `tests/transformAggregatePackets.test.ts`

**Interfaces:**
- Consumes: Tasks 1-3 unified path.
- Produces: no production Graph Builder reference to full-table loading or caching.

- [ ] **Step 1: Add a failing source regression**

Assert Graph Builder pipeline, project store, and workspace production sources do not contain `loadGraphTableData` or `graphTableDataCache`. Assert Graph Builder pipeline sources do not call `queryTableWindow`; table viewport code remains allowed to use it.

- [ ] **Step 2: Run the regression red**

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
```

- [ ] **Step 3: Remove legacy files and imports**

Delete the four legacy files only after symbol search confirms no non-graph caller. Do not remove `dataService.queryTableWindow`, which remains table-owned.

- [ ] **Step 4: Verify aggregate ownership**

Ensure histogram, heatmap, boxplot, and summary paths consume `GraphAggregatePacket`. A packet-backed branch must not reconstruct or iterate a full `unknown[][]` when `frame.sourceRows > 0`.

- [ ] **Step 5: Verify and commit**

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
node --experimental-strip-types tests/transformAggregatePackets.test.ts
node --experimental-strip-types tests/rawPoints.test.ts
node --experimental-strip-types tests/axisBinding.test.ts
node --experimental-strip-types tests/graphAnimation.test.ts
node --experimental-strip-types tests/scatterProgressive.test.ts
npm run build
git add -A
git commit -m "refactor(graph): remove legacy full-table path"
```

---

### Task 5: Run Backend And Repository Regression Gates

**Files:**
- Modify only for a verified integration defect: `src-tauri/src/models/graph_data.rs`
- Modify only for a verified integration defect: `src-tauri/src/services/graph_data_service.rs`
- Modify only for a verified integration defect: `src-tauri/src/engine/duckdb_engine.rs`
- Modify only for a verified integration defect: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: merged save and graph backend.
- Produces: validated IPC registration, ordering, bitmap validity, SQL safety, generation fencing, and save compatibility.

- [ ] **Step 1: Run focused and full Rust tests**

```powershell
cargo test --manifest-path src-tauri/Cargo.toml models::graph_data::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml services::graph_data_service::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: zero failures.

- [ ] **Step 2: Run Clippy**

```powershell
cargo clippy --manifest-path src-tauri/Cargo.toml
```

Expected: exit code 0. Separate existing warnings from integration-introduced warnings.

- [ ] **Step 3: Repair only proven integration defects**

Change the smallest owning unit, rerun the exact failing test, then repeat Steps 1-2. Do not refactor unrelated save or table code.

- [ ] **Step 4: Commit only when repairs were needed**

```powershell
git add src-tauri
git commit -m "fix(graph): reconcile backend integration contracts"
```

Skip when no files changed.

---

### Task 6: Benchmark, Manual Acceptance, And PR Delivery

**Files:**
- Modify: `docs/performance.md`
- Modify only for verified defects: owning graph source and focused tests

**Interfaces:**
- Consumes: automated-test-clean integration.
- Produces: 300,000-row evidence, manual acceptance evidence, pushed branch, and a non-draft PR into `dev`.

- [ ] **Step 1: Run the release graph benchmark**

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation graph_projection
```

Expected: `resultRows=300000`, `selectedColumns=3`, and successful timing output. Record actual emitted transfer fields and measure peak working set using the PowerShell method already documented in `docs/performance.md`; do not invent absent fields.

- [ ] **Step 2: Record observed performance**

Add the exact command, date, machine context, Full Data mode, rows, selected columns, wall time, transferred bytes, and peak working set to the graph section. Preserve prior baselines.

- [ ] **Step 3: Run final automated gates**

```powershell
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
cargo clippy --manifest-path src-tauri/Cargo.toml
git diff --check origin/dev...HEAD
git status --short --branch
```

Expected: all commands succeed and only intended performance documentation remains before commit.

- [ ] **Step 4: Commit benchmark evidence**

```powershell
git add docs/performance.md
git commit -m "docs(perf): record unified graph pipeline results"
```

- [ ] **Step 5: Start Tauri and perform manual acceptance**

```powershell
npm run tauri dev
```

Exercise empty, small, and 300,000-row data across scatter selection, histogram, shadowgram, boxplot/outliers, heatmap, facets, multi-axis fields, 3D, filters, visible progress, rapid cancellation, project switching, field rebinding, same-field zoom preservation, and error display. Do not claim checks that were not exercised.

- [ ] **Step 6: Repair each manual defect test-first**

Add the narrowest failing regression to the owning TS or Rust test, run it red, make the smallest repair, rerun green, then repeat Step 3.

- [ ] **Step 7: Push without rewriting history**

```powershell
git push origin feature/unified-graph-pipeline
```

Never use `--force`.

- [ ] **Step 8: Create the PR with GitHub CLI**

```powershell
$gh = 'C:\Program Files\GitHub CLI\gh.exe'
& $gh pr list --repo ashton2914/StatsPlayground --head feature/unified-graph-pipeline --base dev --state all --json number,title,state,url
```

If no open PR exists, create a non-draft PR titled `feat(graph): integrate unified typed data pipeline`. Include architecture cutover, preserved behavior, automated gates, actual benchmark values, manual checks, warnings, and residual risks. Verify the PR is open, non-draft, and targets `dev` with `gh pr view`.