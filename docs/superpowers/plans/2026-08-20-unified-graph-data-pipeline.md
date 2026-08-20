# Unified Graph Data Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Graph Builder's full-table JSON path with one projection-first, typed-chunk pipeline and one panel-local raw-points renderer that handles every table size and renders 300,000 full-data points responsively.

**Architecture:** Every graph uses `GraphDataRequest -> GraphDataService -> ordered binary chunks -> GraphDataFrame`. DuckDB performs validated projection, filtering, explicit sampling, and exact aggregation. ECharts retains axes and non-raw elements while one Canvas layer inside each `GraphPanel` draws raw points from typed buffers without per-point JavaScript objects.

**Tech Stack:** Rust 2021, DuckDB 1.10505, Tauri 2.10 `Channel<InvokeResponseBody>`, TypeScript 5.7, React 19, ECharts 5.6, Canvas 2D, Node native TypeScript stripping.

## Global Constraints

- Full Data is the default; Sampling is enabled only by an explicit user setting.
- Full Data never silently falls back to Sampling or omits valid filtered observations.
- One production request, response, filtering, and rendering pipeline serves `0`, `1`, `10`, `5,000`, and `300,000` rows.
- Data size may change chunk and scheduling budgets, but never selects a separate small-table implementation.
- Raw IPC payloads are binary buffers, not base64, JSON number arrays, or row-oriented `unknown[][]`.
- Histogram, heatmap, box plot, summary, and interval results use all filtered rows even when raw-point Sampling is enabled.
- SQL values are parameters; identifiers are validated against dataset metadata and quoted.
- Request ID and dataset generation guard every asynchronous result.
- Existing Graph Builder project documents remain readable; persisted Sampling defaults to Full Data when absent.
- ECharts remains pinned to the repository's current 5.6 package unless a separate dependency decision is approved.
- Reference spec: `docs/superpowers/specs/2026-08-20-graph-save-large-data-performance-design.md`.

## File Structure

### New Files

- `src-tauri/src/models/graph_data.rs`: wire request, header, completion, sampling, field, and aggregate models.
- `src-tauri/src/services/graph_data_service.rs`: request validation, projection, filter SQL, exact aggregates, sampling, and binary chunk encoding.
- `src-tauri/src/commands/graph_data_commands.rs`: async stream and cancellation commands.
- `src/types/graphData.ts`: TypeScript wire mirrors, binary frame model, and payload decoder.
- `src/services/graphDataService.ts`: Tauri channel lifecycle and cancellation wrapper.
- `src/components/graphBuilder/useGraphDataPipeline.ts`: request construction, stale-result handling, and coherent frame commit.
- `src/graphCore/rawPoints.ts`: pure axis mapping, drawing batches, pixel index, hit testing, and deterministic jitter.
- `src/graphCore/RawPointsLayer.tsx`: panel-local Canvas lifecycle.
- `tests/graphDataPipeline.test.ts`: channel reducer and frame lifecycle regressions.
- `tests/rawPoints.test.ts`: geometry, overpainting, hit testing, and pixel digest regressions.

### Modified Files

- `src-tauri/src/models/mod.rs`, `src-tauri/src/services/mod.rs`, `src-tauri/src/commands/mod.rs`, `src-tauri/src/lib.rs`: register graph modules and commands.
- `src-tauri/src/engine/duckdb_engine.rs`: expose validated graph projection and aggregate query primitives.
- `src/components/graphBuilder/GraphBuilderView.tsx`: replace full-table fetch and frontend filtering/melt with the graph pipeline hook.
- `src/components/graphBuilder/graphBuilder.css`: loading/error/sampling status presentation only.
- `src/graphCore/types.ts`: replace row-oriented graph input with `GraphDataFrame` references.
- `src/graphCore/transform.ts`: consume aggregate packets and emit panel raw-point descriptors instead of raw scatter objects.
- `src/graphCore/Graph.tsx`: host `RawPointsLayer` in each `GraphPanel` and route click/brush interaction.
- `src/types/graphBuilder.ts`, `src/stores/useGraphBuilderStore.ts`: persist explicit Full/Sample settings.
- `src/i18n/locales/{en,vi,zh-CN,zh-TW}.json`: sampling mode and row-count status strings.
- `src-tauri/src/perf_harness.rs`, `src-tauri/examples/performance_baseline.rs`, `docs/performance.md`: graph baseline operation and results.

---

### Task 1: Add Reproducible Graph Baselines

**Files:**
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `docs/performance.md`
- Create: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Produces: performance operation `graph_projection` with JSON fields `rows`, `columns`, `operationMs`, `resultRows`, and `selectedColumns`.
- Produces: a pure test fixture generator `makeGraphRows(count: number)` used by later TS tests.

- [ ] **Step 1: Write the failing Rust operation test**

Add `GraphProjection` to `Operation` and this test before implementing the branch:

```rust
#[test]
fn performance_cli_projects_only_graph_columns() {
    let report = execute(Options {
        rows: 300_000,
        columns: 20,
        operation: Operation::GraphProjection,
    })
    .unwrap();

    assert_eq!(report.result_rows, 300_000);
    assert_eq!(report.selected_columns, 3);
}
```

- [ ] **Step 2: Run the test and verify the red state**

Run: `cargo test --manifest-path src-tauri/Cargo.toml performance_cli_projects_only_graph_columns -- --nocapture`

Expected: compilation fails because `GraphProjection` and `selected_columns` do not exist.

- [ ] **Step 3: Implement the baseline operation**

Extend the CLI parser with `graph_projection`; seed columns `_row_id`, `col_0`, and `col_1`; run a direct three-column DuckDB projection; consume all rows; and report `selectedColumns: 3`. Do not call the future graph service in this baseline.

- [ ] **Step 4: Add the TS fixture and baseline note**

Create `tests/graphDataPipeline.test.ts` with:

```ts
import assert from "node:assert/strict";

export function makeGraphRows(count: number): Array<[number, string, number]> {
  return Array.from({ length: count }, (_, index) => [
    index + 1,
    ["Central", "East", "North", "South", "West"][index % 5],
    (index * 37) % 7200,
  ]);
}

assert.equal(makeGraphRows(10).length, 10);
console.log("graph-data fixture passed");
```

Document the release command and record wall time and peak working set for the old `GraphBuilderView` path manually in `docs/performance.md`.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml performance_cli_projects_only_graph_columns -- --nocapture
node --experimental-strip-types tests/graphDataPipeline.test.ts
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation graph_projection
```

Expected: test passes, fixture prints success, report has `resultRows=300000` and `selectedColumns=3`.

Commit:

```powershell
git add src-tauri/src/perf_harness.rs tests/graphDataPipeline.test.ts docs/performance.md
git commit -m "test(graph): baseline large graph projection"
```

---

### Task 2: Define And Decode The Ordered Binary Contract

**Files:**
- Create: `src-tauri/src/models/graph_data.rs`
- Modify: `src-tauri/src/models/mod.rs`
- Create: `src/types/graphData.ts`
- Modify: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Consumes: existing `TableWindowFilter` semantics.
- Produces: Rust `GraphDataRequest`, `GraphFieldBinding`, `GraphElementRequest`, `GraphSampling`, `GraphChunkHeader`, `GraphDataCompletion`.
- Produces: TS `GraphDataFrame`, `GraphChunkMessage`, and `decodeGraphPayload(header, payload)`.

- [ ] **Step 1: Write Rust serde and validation-shape tests**

Define tests expecting this JSON to deserialize:

```rust
let request: GraphDataRequest = serde_json::from_value(serde_json::json!({
    "requestId": "req-1",
    "datasetId": "dataset-id",
    "generation": 7,
    "fields": [
        { "role": "x", "column": "region" },
        { "role": "y", "column": "cost" }
    ],
    "filters": [],
    "elements": [{ "kind": "points", "summaryStat": "none" }],
    "sampling": { "mode": "full" },
    "viewport": { "width": 1200, "height": 700 }
})).unwrap();
assert_eq!(request.request_id, "req-1");
assert!(matches!(request.sampling, GraphSampling::Full));
```

Add a binary-layout test asserting offsets are aligned to eight bytes and slices do not overlap.

- [ ] **Step 2: Run Rust tests and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml models::graph_data::tests -- --nocapture`

Expected: module/type-not-found compilation failure.

- [ ] **Step 3: Implement exact Rust models**

Use tagged enums:

```rust
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphDataRequest {
    pub request_id: String,
    pub dataset_id: String,
    pub generation: u64,
    pub fields: Vec<GraphFieldBinding>,
    pub filters: Vec<TableWindowFilter>,
    pub elements: Vec<GraphElementRequest>,
    pub sampling: GraphSampling,
    pub viewport: GraphViewport,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "mode", rename_all = "camelCase")]
pub enum GraphSampling {
    Full,
    Sample { size: usize, seed: u64 },
}
```

`GraphChunkHeader` includes `requestId`, `generation`, `chunkIndex`, `rowOffset`, `rowCount`, `sourceRows`, `processedRows`, dictionaries, validity ranges, typed slice descriptors, and `finalChunk`.

Define the frontend frame consumed by every later task exactly once in `src/types/graphData.ts`:

```ts
export interface GraphDataFrame {
    requestId: string;
    datasetId: string;
    generation: number;
    sourceRows: number;
    processedRows: number;
    sampling: GraphSampling;
    dictionaries: Record<string, readonly string[]>;
    extents: Record<string, { min: number; max: number }>;
    rawChunks: readonly DecodedRawPointChunk[];
    aggregates: readonly GraphAggregatePacket[];
}

export interface DecodedRawPointChunk {
    chunkIndex: number;
    rowOffset: number;
    rowCount: number;
    xValues: Float64Array | Uint32Array;
    yValues: Float64Array;
    rowIds: BigInt64Array;
    groupCodes?: Uint32Array;
    sizeValues?: Float64Array;
    validity: Record<string, Uint8Array>;
}
```

`GraphAggregatePacket` is a discriminated union with `kind` values
`histogram`, `heatmap`, `boxPlot`, and `summary`; Task 6 adds each packet's
payload fields without changing `GraphDataFrame`.

- [ ] **Step 4: Write failing TS decoder tests**

Extend `tests/graphDataPipeline.test.ts` with one numeric/category payload fixture and assert decoded `Float64Array`, `Uint32Array`, `BigInt64Array`, dictionary, and validity bitmap values.

Run: `node --experimental-strip-types tests/graphDataPipeline.test.ts`

Expected: module import or decoder symbol failure.

- [ ] **Step 5: Implement TS mirrors and decoder**

`decodeGraphPayload` must use `ArrayBuffer` views with header offsets and must not copy the payload. Reject out-of-range or misaligned slices with `GraphPayloadError`.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml models::graph_data::tests -- --nocapture
node --experimental-strip-types tests/graphDataPipeline.test.ts
npx tsc -b --pretty false
```

Commit:

```powershell
git add src-tauri/src/models/graph_data.rs src-tauri/src/models/mod.rs src/types/graphData.ts tests/graphDataPipeline.test.ts
git commit -m "feat(graph): define typed graph data contract"
```

---

### Task 3: Stream Projected Full-Data Chunks From DuckDB

**Files:**
- Create: `src-tauri/src/services/graph_data_service.rs`
- Create: `src-tauri/src/commands/graph_data_commands.rs`
- Modify: `src-tauri/src/services/mod.rs`
- Modify: `src-tauri/src/commands/mod.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src-tauri/src/lib.rs`

**Interfaces:**
- Consumes: `GraphDataRequest` from Task 2.
- Produces: `GraphDataService::stream(&GraphDataRequest, &Channel<InvokeResponseBody>) -> Result<GraphDataCompletion, AppError>`.
- Produces commands `stream_graph_data` and `cancel_graph_data`.

- [ ] **Step 1: Write failing service tests for the scale matrix**

For `0`, `1`, `10`, `5_000`, and `300_000` rows, assert:

```rust
let chunks = service.collect_for_test(&request).unwrap();
assert_eq!(chunks.iter().map(|chunk| chunk.header.row_count).sum::<usize>(), row_count);
assert_eq!(chunks.last().unwrap().header.final_chunk, true);
assert_eq!(chunks[0].header.projected_columns, vec!["_row_id", "region", "cost"]);
```

Add tests for a stale generation, an unknown column, chunk-boundary uniqueness of row IDs, and filtering before encoding.

- [ ] **Step 2: Run tests and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::graph_data_service::tests -- --nocapture`

Expected: module or service symbol failure.

- [ ] **Step 3: Implement validation and projection**

Resolve requested names against `get_user_columns`, add `_row_id` only when point interaction requires it, compile existing `TableWindowFilter` values as parameters, and query only the resolved columns ordered by `_row_id ASC`.

Use a fixed initial payload budget of 4 MiB. Encode contiguous aligned slices into one `Vec<u8>` per chunk. Do not create `Vec<Vec<Value>>`.

- [ ] **Step 4: Implement ordered channel streaming**

Register:

```rust
#[tauri::command(async)]
pub fn stream_graph_data(
    state: State<'_, AppState>,
    request: GraphDataRequest,
    on_chunk: Channel<InvokeResponseBody>,
) -> Result<GraphDataCompletion, AppError>
```

Send a JSON header followed immediately by its raw payload. Track cancelled request IDs in the service and check cancellation between DuckDB batches. Channel-send failure returns `AppError::InvalidParam("graph data channel closed".into())` unless the request was cancelled.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::graph_data_service::tests -- --nocapture
cargo test --manifest-path src-tauri/Cargo.toml commands::graph_data_commands::tests -- --nocapture
cargo check --manifest-path src-tauri/Cargo.toml
```

Commit:

```powershell
git add src-tauri/src/services/graph_data_service.rs src-tauri/src/commands/graph_data_commands.rs src-tauri/src/services/mod.rs src-tauri/src/commands/mod.rs src-tauri/src/engine/duckdb_engine.rs src-tauri/src/lib.rs
git commit -m "feat(graph): stream projected graph data chunks"
```

---

### Task 4: Build One Frontend Request And Frame Lifecycle

**Files:**
- Create: `src/services/graphDataService.ts`
- Create: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Modify: `src/types/graphBuilder.ts`
- Modify: `src/stores/useGraphBuilderStore.ts`
- Modify: `tests/graphDataPipeline.test.ts`

**Interfaces:**
- Consumes: Task 2 headers and decoder; Task 3 commands.
- Produces: `graphDataService.stream(request, handlers)` and `useGraphDataPipeline(item, dataset, viewport)`.
- Produces: persisted `sampling: { mode: "full" } | { mode: "sample"; size: number; seed: number }`.

- [ ] **Step 1: Write failing reducer tests**

Extract and test `reduceGraphStream(state, message)` for ordered header/payload pairs, stale request IDs, stale generations, duplicate chunk indexes, cancellation, and atomic pending-to-committed frame swap. The previous committed frame must remain after an error.

- [ ] **Step 2: Run the test and verify failure**

Run: `node --experimental-strip-types tests/graphDataPipeline.test.ts`

Expected: reducer symbols do not exist.

- [ ] **Step 3: Implement the service wrapper**

Use `Channel<unknown>` from `@tauri-apps/api/core`. Accept object headers and `ArrayBuffer` payloads in order, pair them by chunk index, decode without copies, and call `invoke("stream_graph_data", { request, onChunk: channel })`. Invoke `cancel_graph_data` in cleanup.

- [ ] **Step 4: Implement the hook and persisted default**

The hook derives required fields from every active role, element, facet, 3D binding, `hiddenGroups`, and filter. It reads generation before dispatch. Missing persisted sampling becomes `{ mode: "full" }`. Use one debounced viewport update but do not debounce field/filter changes.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
npx vite build
```

Commit:

```powershell
git add src/services/graphDataService.ts src/components/graphBuilder/useGraphDataPipeline.ts src/types/graphBuilder.ts src/stores/useGraphBuilderStore.ts tests/graphDataPipeline.test.ts
git commit -m "feat(graph): manage streamed graph frames"
```

---

### Task 5: Add The Unified Panel-Local Raw-Points Layer

**Files:**
- Create: `src/graphCore/rawPoints.ts`
- Create: `src/graphCore/RawPointsLayer.tsx`
- Create: `tests/rawPoints.test.ts`
- Modify: `src/graphCore/Graph.tsx`
- Modify: `src/graphCore/types.ts`
- Modify: `src/graphCore/transform.ts`

**Interfaces:**
- Consumes: committed typed `GraphDataFrame` from Task 4.
- Produces: `RawPointPanelDescriptor`, `drawRawPoints`, `buildPixelIndex`, `hitTestPoint`, and `hitTestBrush`.

- [ ] **Step 1: Write failing pure geometry tests**

Cover numeric affine mapping, categorical dictionary mapping, missing-value exclusion, facet masks, same-pixel overpainting, topmost and overlap hit results, rectangle brush row IDs, and deterministic explicit jitter. Add a fixed 64x64 RGBA digest fixture for ten points.

- [ ] **Step 2: Run the tests and verify failure**

Run: `node --experimental-strip-types tests/rawPoints.test.ts`

Expected: raw-point module not found.

- [ ] **Step 3: Implement pure drawing and index functions**

Operate directly on typed views. Draw in batches scheduled by `requestAnimationFrame`; the same loop handles every row count. Build a bounded pixel-cell index containing compact source offsets, not point objects. Default jitter is `none`; explicit jitter uses the request seed.

- [ ] **Step 4: Host Canvas inside each GraphPanel**

Extend each built panel with a `RawPointPanelDescriptor`. Mount `RawPointsLayer` inside `GraphPanel` so every facet has its own clip rectangle and ECharts coordinate system. Derive numeric transforms from `convertToPixel` samples and categorical coordinates from dictionary entries. Redraw after option, resize, zoom, and pan updates.

Layer order must be tested: fills/bars below raw points; ECharts labels, tooltips, and reference-line interaction above them. The Canvas must not intercept axis gestures outside the plot rectangle.

- [ ] **Step 5: Route clicks and brushes through the pixel index**

Move raw `ScatterPointPick` ownership to `rawPoints.ts`. Query Canvas hit testing before ECharts series click handling. Replace the current raw-series brush scan with `hitTestBrush`; keep ECharts handling for aggregate and synthetic series.

- [ ] **Step 6: Verify and commit**

Run:

```powershell
node --experimental-strip-types tests/rawPoints.test.ts
node --experimental-strip-types tests/graphDataPipeline.test.ts
npx vite build
```

Commit:

```powershell
git add src/graphCore/rawPoints.ts src/graphCore/RawPointsLayer.tsx src/graphCore/Graph.tsx src/graphCore/types.ts src/graphCore/transform.ts tests/rawPoints.test.ts
git commit -m "feat(graph): render raw points from typed buffers"
```

---

### Task 6: Move Filters, Melt, Sampling, And Exact Aggregates Backend-Side

**Files:**
- Modify: `src-tauri/src/models/graph_data.rs`
- Modify: `src-tauri/src/services/graph_data_service.rs`
- Modify: `src-tauri/src/engine/duckdb_engine.rs`
- Modify: `src/types/graphData.ts`
- Modify: `src/components/graphBuilder/useGraphDataPipeline.ts`
- Modify: `src/graphCore/transform.ts`

**Interfaces:**
- Consumes: unified request and response lifecycle.
- Produces aggregate packets `HistogramPacket`, `HeatmapPacket`, `BoxPlotPacket`, `SummaryPacket`, and typed virtual melt fields.

- [ ] **Step 1: Write failing exactness and sampling tests**

For every scale, compare service packets to direct DuckDB SQL. Test grouped/faceted filters, missing values, multi-column melt, box outliers, histogram counts, summary intervals, and hidden groups. Assert Sampling with the same seed is reproducible and that aggregate packets are byte-for-byte equal between Full and Sample requests.

- [ ] **Step 2: Run focused tests and verify failure**

Run: `cargo test --manifest-path src-tauri/Cargo.toml services::graph_data_service::tests::aggregate -- --nocapture`

Expected: packet variants or query implementations are missing.

- [ ] **Step 3: Implement backend aggregate and virtual-column queries**

Compile each element into one projection or aggregate query plan. Use DuckDB `UNPIVOT` or an equivalent validated `UNION ALL` for multi-column melt; never expand rows in JavaScript. Sampling applies only to raw-observation packet production and is stratified by active categorical/group/facet roles.

- [ ] **Step 4: Consume packets in transform**

Replace frontend filtering, melt, histogram, heatmap, box, and summary row scans with packet conversion. ECharts continues to render aggregate/synthetic series. Remove any raw-data requirement from those transform branches.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
cargo test --manifest-path src-tauri/Cargo.toml services::graph_data_service::tests -- --nocapture
node --experimental-strip-types tests/graphDataPipeline.test.ts
node --experimental-strip-types tests/rawPoints.test.ts
npx vite build
```

Commit:

```powershell
git add src-tauri/src/models/graph_data.rs src-tauri/src/services/graph_data_service.rs src-tauri/src/engine/duckdb_engine.rs src/types/graphData.ts src/components/graphBuilder/useGraphDataPipeline.ts src/graphCore/transform.ts
git commit -m "feat(graph): compute graph aggregates in DuckDB"
```

---

### Task 7: Cut GraphBuilderView Over And Remove The Legacy Production Path

**Files:**
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/graphBuilder/graphBuilder.css`
- Modify: `src/graphCore/types.ts`
- Modify: `src/graphCore/transform.ts`
- Modify: `src/services/dataService.ts`
- Modify: `src/i18n/locales/{en,vi,zh-CN,zh-TW}.json`

**Interfaces:**
- Consumes: `useGraphDataPipeline` and `GraphDataFrame`.
- Produces: one production graph path with explicit Full/Sample UI and source/processed row status.

- [ ] **Step 1: Add a source guard regression**

Extend `tests/graphDataPipeline.test.ts` to read `GraphBuilderView.tsx` and assert it does not contain a graph-path call to `dataService.queryTable`, frontend `applyFilters(data`, or `newRows.push([...row` melt expansion.

- [ ] **Step 2: Run the guard and verify failure**

Run: `node --experimental-strip-types tests/graphDataPipeline.test.ts`

Expected: assertion fails on the current legacy code.

- [ ] **Step 3: Replace GraphBuilderView data preparation**

Use the hook's committed frame. Keep column display metadata retrieval bounded and separate. Show loading while retaining the prior frame, display errors without blanking it, and show `Full Data: {{processed}} rows` or `Sampled: {{processed}} / {{source}} rows`.

Add a mode control whose default is Full. Sampling requires an explicit sample size and persists in the graph builder item.

- [ ] **Step 4: Remove legacy row-oriented graph code**

Delete the full-table graph query effect, frontend filter/melt path, raw-point object path, and any `GraphData` production fallback. Keep `queryTable` for non-graph consumers. Remove dead exports and imports.

- [ ] **Step 5: Verify and commit**

Run:

```powershell
node --experimental-strip-types tests/graphDataPipeline.test.ts
node --experimental-strip-types tests/rawPoints.test.ts
npx vite build
cargo test --manifest-path src-tauri/Cargo.toml
```

Commit:

```powershell
git add src/components/graphBuilder/GraphBuilderView.tsx src/components/graphBuilder/graphBuilder.css src/graphCore/types.ts src/graphCore/transform.ts src/services/dataService.ts src/i18n/locales
git commit -m "refactor(graph): use unified graph data pipeline"
```

---

### Task 8: Enforce Performance And Full Regression Gates

**Files:**
- Modify: `src-tauri/src/perf_harness.rs`
- Modify: `src-tauri/examples/performance_baseline.rs`
- Modify: `docs/performance.md`
- Modify: `tests/rawPoints.test.ts`

**Interfaces:**
- Consumes: completed graph service and renderer.
- Produces: release benchmark report for `graph` with `queryMs`, `encodeMs`, `decodeMs`, `drawMs`, `processedRows`, `transferredBytes`, and peak-memory measurement instructions.

- [ ] **Step 1: Extend the benchmark to the production graph service**

Add operation `graph` that constructs the exact Full Data `region`/`cost` request, collects production chunks, and asserts `processedRows == 300_000`. Measure Rust query and encoding in the CLI; measure TypeScript decode and Canvas draw in the desktop run from Step 3 because Node has no repository-provided Canvas implementation.

- [ ] **Step 2: Run the release benchmark**

Run:

```powershell
cargo run --release --manifest-path src-tauri/Cargo.toml --example performance_baseline --features perf-harness -- --rows 300000 --columns 20 --operation graph
```

Expected: projection is exactly three columns and service processing is within the backend portion of the 2-second cold target.

- [ ] **Step 3: Validate the desktop performance gates**

Run the Tauri app against the existing 300,000-row project. Record cold and warm complete-frame times, WebView tasks over 200 ms, transferred bytes, and peak working set. Verify Sampling is off and `processedRows` is 300,000.

If a gate fails, profile that stage and optimize binary encoding, Canvas draw batching, or pixel indexing inside the same pipeline. Do not add a row-count branch or implicit Sampling.

- [ ] **Step 4: Run full verification**

Run:

```powershell
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
cargo test --manifest-path src-tauri/Cargo.toml
cargo build --manifest-path src-tauri/Cargo.toml
node --experimental-strip-types tests/graphDataPipeline.test.ts
node --experimental-strip-types tests/rawPoints.test.ts
npm run build
```

Run Clippy and record only pre-existing repository warnings separately:

```powershell
cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets --all-features -- -D warnings
```

- [ ] **Step 5: Update results and commit**

Record baseline and optimized measurements in `docs/performance.md`, including machine, release profile, project, Full/Sample mode, and row count.

Commit:

```powershell
git add src-tauri/src/perf_harness.rs src-tauri/examples/performance_baseline.rs tests/rawPoints.test.ts docs/performance.md
git commit -m "perf(graph): enforce full-data graph targets"
```

---

## Fix Round 2 Report (2026-08-20)

Scope: Task 6 follow-up fixes in the unified worktree.

### Finding 1 (CRITICAL) — Helper scope leak closed

- `buildBandRefLinesCarrier` no longer references a free `frameBackedAggregateMode`; it now accepts explicit context via `aggregateMode`.
- `buildAxisOverrides` no longer references a free `frameBackedAggregateMode`; it now accepts explicit context via `aggregateMode`.
- Added source guard in `tests/transformAggregatePackets.test.ts` to assert both helper signatures carry explicit aggregate context.

### Finding 2 (IMPORTANT) — Frame-backed histogram row-scan isolation

- Added packet-first grouping/category derivation for histogram-only frame-backed mode.
- Added explicit packet-only early return for per-category histogram-only mode so downstream generic row scans are skipped.
- Removed frame-backed fallback to raw-row extent scans by deriving missing extents from packet bins before any legacy-row fallback.
- Ensured frame-backed group slot generation and mode-A binning avoid row-index maps and row observation loops.

### Finding 3 (TEST GAP) — Direct SQL equality coverage added

Added exact packet-vs-SQL tests in `src-tauri/src/services/graph_data_service.rs`:

- `heatmap_packet_matches_direct_sql_cells_edges_and_missing_count`
    - verifies exact grouped cell counts and exact bin indices against SQL `CASE`/`FLOOR` grouping;
    - verifies missing exclusion and edge-bin handling.
- `boxplot_packet_matches_direct_sql_quantiles_whiskers_and_outlier_ids`
    - verifies exact `q1`/`median`/`q3`, whiskers, and outlier row-id identity sets against direct SQL.
- `summary_packet_matches_direct_sql_median_and_intervals_for_grouped_melt`
    - verifies grouped+melt summary count/mean/median/stddev/min/max and interval low/high against direct SQL.

Existing scale gates (`0/1/10/5000/300000`) remain intact.

### Finding 4 — Histogram fallback masking closed

- Non-empty packet style generation now has explicit coverage in `tests/transformAggregatePackets.test.ts` for `bar`/`polygon`/`kde`/`shadowgram`.
- Test asserts no `__hist_packet_fallback_*` series appears for non-empty packet bins.
- Runtime fallback is now restricted to empty-data continuity (`totalCount === 0`) so it no longer hides style-generation regressions.

### Verification run

- `cargo test --manifest-path src-tauri/Cargo.toml services::graph_data_service::tests -- --nocapture` ✅
- `node --experimental-strip-types tests/transformAggregatePackets.test.ts` ✅
- `node --experimental-strip-types tests/graphDataPipeline.test.ts` ✅
- `node --experimental-strip-types tests/rawPoints.test.ts` ✅
- `npx tsc -b --pretty false` ✅
- `npx vite build` ✅

---

## Fix Round 3 Report (2026-08-20)

Scope: Graph Task 6 final Important issue in unified worktree (frame-backed histogram fallback isolation and gating).

### Finding 1 (IMPORTANT) — Frame-backed malformed histogram extents no longer touch legacy rows

- Removed the frame-backed extent fallback that scanned `data.rows` when histogram packet min/max and bin edges were non-finite.
- Frame-backed histogram extent resolution now stays packet/axis-only:
    - packet `minValue`/`maxValue` when finite,
    - packet bin edges when finite,
    - axis pins (`spec.yAxis.min/max`) when present,
    - final safe span fallback (`[0, 1]`) when packet extents are malformed.
- Legacy `GraphData` row scanning remains in a disjoint non-frame branch only.

### Finding 2 (IMPORTANT) — Frame-backed synthetic histogram fallback gating tightened to `totalCount === 0`

- Mode-A packet fallback (`__hist_packet_fallback_mode_a`) is now gated by `Number(histogramPacket.totalCount) === 0`.
- Final frame-backed histogram fallback block no longer checks `data.rows.length === 0`; it is now gated by `Number(histogramPacket.totalCount) === 0`.
- Result: non-empty packet style-generation failures are no longer masked by synthetic bars.

### Added RED/GREEN coverage

In `tests/transformAggregatePackets.test.ts`:

- Added malformed packet extent guard with inaccessible/throwing rows proxy and `assert.doesNotThrow` to verify frame-backed histogram mode never accesses legacy rows.
- Added mode-A fallback gating assertions:
    - non-empty packet must not emit `__hist_packet_fallback_mode_a`;
    - empty packet may emit `__hist_packet_fallback_mode_a`.
- Added non-empty final-fallback guard assertion:
    - non-empty packet must not emit `__hist_packet_fallback_final_*`.

### Verification run

- `node --experimental-strip-types tests/transformAggregatePackets.test.ts` ✅
- `node --experimental-strip-types tests/graphDataPipeline.test.ts` ✅
- `node --experimental-strip-types tests/rawPoints.test.ts` ✅
- `npx tsc -b --pretty false` ✅
- `npx vite build` ✅
