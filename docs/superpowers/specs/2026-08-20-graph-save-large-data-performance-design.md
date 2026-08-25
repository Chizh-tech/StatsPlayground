# Graph Builder And Project Save Large-Data Performance Design

## Status

Approved on 2026-08-20.

This specification refines the Graph Builder and project-save portions of the
broader big-data design. It targets the current v3 ZIP/JSON project format and
does not introduce the proposed file-backed v4 format. Existing `.spprj` and
`.sptb` files remain compatible.

## Goal

Make Graph Builder and project saving responsive and predictably fast for
tables containing hundreds of thousands of rows without silently changing the
meaning of a graph.

The reference workload is the existing 300,000-row project. The reference
Graph Builder case plots the categorical `region` column against the numeric
`cost` column with the Points element and no summary statistic. JMP renders
that case with all 300,000 rows when its optional Sampling setting has not been
applied. StatsPlayground must treat that full-data behavior as the baseline.

## Product Decisions

- Full Data is the default Graph Builder mode.
- Sampling is used only when the user explicitly enables it.
- Sampling never changes exact histogram, heatmap, box plot, summary, or
  interval calculations.
- The same data pipeline is used at every table size. Data volume can change
  batch sizes and scheduling parameters, but it cannot select a separate
  small-table implementation.
- Project saving runs in the background. The project remains browsable but is
  read-only until the save succeeds or fails.
- Saving always uses the streaming writer, including for empty and small
  projects.
- The current archive shape and atomic temporary-file replacement behavior are
  preserved.

## Non-Goals

- Changing `.spprj` into a DuckDB database or changing `.sptb` to Parquet.
- Automatically sampling a full-data graph when memory or rendering limits are
  reached.
- Replacing ECharts for axes, legends, layout, reference lines, or aggregated
  chart elements.
- Allowing project mutations while a save is in progress.
- Adding a second database snapshot so users can continue editing during save.

## Current Bottlenecks

### Graph Builder

`GraphBuilderView` calls the generic table query API with a page size equal to
the dataset row count. The backend selects `_row_id` plus every user column,
converts every DuckDB value into `serde_json::Value`, and returns nested rows
through Tauri IPC. The frontend then performs filtering, grouping, melting,
axis scanning, jitter calculation, and ECharts data-object construction.

For a raw point with row-selection metadata, the final path allocates both an
intermediate point object and an ECharts object carrying `value` and `__pick`.
The default stacked jitter also bins and positions every point. These costs are
paid even when a graph binds only two columns.

JMP has a materially shorter path: its resident column data feeds a native
renderer without a row-oriented JSON boundary. Its optional Sampling control
can reduce drawing work, but the verified 300,000-row reference graph did not
have that suggested sample size applied. The performance difference therefore
cannot be addressed by silently sampling StatsPlayground data.

### Project Save

The current save path composes every dataset into a complete `TableDoc`, which
retains all rows as a `Vec<Vec<serde_json::Value>>`. Archive writing then calls
`serde_json::to_vec`, creating another complete byte buffer before compression.
Peak memory can include DuckDB storage, the JSON value tree, serialized JSON,
and ZIP compression buffers at the same time.

The Tauri `save_project` command is synchronous. Long row conversion and ZIP
work can therefore make the UI appear unresponsive. Moving only the command to
an asynchronous worker would improve responsiveness but would not remove the
large allocations, long database lock, or unnecessary copies.

## Unified Pipeline Invariant

There is one production data path for each feature:

```text
Every Graph Builder request
  -> GraphDataRequest
  -> DuckDB projection/filter/aggregation
  -> typed columnar chunks
  -> unified renderer

Every project save
  -> SaveCoordinator
  -> batched DuckDB reads
  -> incremental JSON serialization
  -> ZIP temporary file
  -> atomic replacement
```

Small inputs can complete in one chunk. Large inputs use multiple chunks. The
request, response, renderer, serialization, progress, and error semantics are
otherwise identical.

During migration, the old Graph Builder path can remain behind test-only or
development comparison code. It is not a production fallback and is deleted
after all supported graph elements use the new contract.

## Graph Data Architecture

### Request Contract

All Graph Builder elements use one request envelope:

```ts
interface GraphDataRequest {
  datasetId: string;
  generation: number;
  fields: GraphFieldBinding[];
  filters: GraphFilter[];
  elements: GraphElementRequest[];
  sampling:
    | { mode: "full" }
    | { mode: "sample"; size: number; seed: number };
  viewport: { width: number; height: number };
}
```

The field bindings identify only the columns required by X, Y, Group, Overlay,
Size, Color, facets, and row selection. Filters are compiled into the same
validated backend predicate representation used by managed-table queries.
User-provided values remain parameters; identifiers are validated and quoted.

The request includes the dataset generation. A generation mismatch returns a
stale-result error before expensive work begins.

### Response Envelope

Raw observations are returned as typed columnar chunks rather than nested JSON
rows:

```ts
interface RawPointChunk {
  requestId: string;
  generation: number;
  rowOffset: number;
  rowCount: number;
  xValues: NumericBuffer | DictionaryBuffer;
  yValues: NumericBuffer;
  rowIds: IntegerBuffer;
  groupCodes?: DictionaryBuffer;
  sizeValues?: NumericBuffer;
  final: boolean;
}
```

Numeric columns use contiguous numeric buffers. Categorical columns use a
dictionary and integer codes. Missing values use a validity bitmap. The wire
encoding must not allocate one Rust enum, JSON object, or JavaScript object per
cell. The implementation plan must verify the most direct binary IPC mechanism
supported by the pinned Tauri version before selecting the concrete buffer
wrapper.

Chunk size is based on an encoded-byte budget, not an arbitrary row count.
Small datasets still return this envelope as one final chunk.

Aggregated elements return typed aggregate packets inside the same request and
response lifecycle. They do not fall back to the old `GraphData` route.

### Backend Responsibilities

`GraphDataService` owns graph data preparation:

- Validate bindings, filters, sampling settings, and generation.
- Project only required columns.
- Apply filters in DuckDB for every dataset size.
- Return raw full-data point columns without row-oriented conversion.
- Perform explicit, deterministic, stratified sampling when requested.
- Compute histogram and heatmap bins from all filtered rows.
- Compute box plot quantiles, whiskers, and outliers from all filtered rows.
- Compute summary statistics and intervals from all filtered rows.
- Return data extents and category dictionaries once per response.

Sampling uses a stable seed and preserves represented categories and groups.
The response reports `sourceRows`, `processedRows`, and sampling metadata. Full
Data requires `processedRows` to equal the number of valid filtered rows.

### Unified Raw-Points Renderer

ECharts continues to own chart layout, axes, legends, zoom state, reference
lines, and non-point elements. A Canvas points layer aligned to each ECharts
grid owns raw observation rendering at every dataset size.

The points layer:

- Consumes the typed columnar buffers directly.
- Maps every Full Data observation to screen coordinates.
- Draws in batches without creating an object for each point.
- Allows points that resolve to the same pixel to overpaint. This is full-data
  rasterization, not sampling.
- Uses the same rendering function for ten and 300,000 observations.
- Redraws from retained typed buffers on zoom or pan without new IPC work.
- Builds a bounded spatial index for hover and click interaction.
- Reports overlapping row counts and can resolve source row IDs on demand.

Jitter is an explicit visual option. It is not applied by default to every
full-data point. When enabled, its algorithm must operate on the same columnar
buffers and remain deterministic.

If profiling proves that the pinned ECharts version can provide the required
batch performance and interaction semantics through one mode at all sizes, the
implementation may use that mode instead of the Canvas layer. It cannot use
ordinary scatter for small tables and a behaviorally different large mode for
large tables.

### Request Lifecycle

Each request has a unique request ID. Dragging fields, changing filters, or
switching datasets invalidates the previous request. Chunks from an invalid or
stale generation are discarded before they update render buffers.

The previous complete graph remains visible until a new request has enough
data to commit a coherent frame. A failed request reports an error and leaves
that previous frame intact. Cancellation and stale-result handling are part of
the common pipeline, including one-chunk small datasets.

## Streaming Project Save Architecture

### Save Coordinator

`AppState` owns a `SaveCoordinator` with an atomic saving state and an RAII
guard. Starting a save while another is active returns a specific busy error.
Dropping the guard after success, failure, or panic-safe unwinding restores the
normal mutation state.

Every mutating service entry point checks the coordinator. The frontend
read-only UI is not the consistency boundary; backend mutation rejection is.
Read-only commands remain available.

At save start, the service captures the project metadata, dataset list,
dataset generations, graph builders, tabulates, folders, history, and snapshots
that belong to the saved version. Because mutations are rejected until save
ends, these values remain coherent without a second full database snapshot.

### Batched Table Reads

Rows are read in `_row_id ASC` order using keyset pagination:

```sql
WHERE _row_id > ?
ORDER BY _row_id
LIMIT ?
```

Gaps in row IDs are valid. `OFFSET` is not used because its repeated scan cost
grows with the saved position.

For each batch, save obtains the database lock, reads and converts the bounded
batch, records the last row ID, and releases the lock. Serialization and ZIP
compression happen after release. This permits read requests to run between
save batches while backend mutation remains prohibited.

Batch size is controlled by an encoded-byte and latency budget. The same loop
handles every table size; small tables finish after one batch.

### Incremental Archive Writing

The writer starts each table's existing `.sptb` JSON object directly inside its
ZIP entry. It serializes metadata and the opening rows array once, serializes
each row as batches arrive, then writes the closing JSON delimiters. It never
constructs a complete `TableDoc.rows` tree or a complete serialized table byte
buffer.

The streaming writer and the existing standalone table writer share one archive
cell encoder. Scalar values, tagged complex values, BLOB hex, nulls, and legacy
compatibility rules cannot be implemented independently in the two paths.

Graph, tabulate, folder, history, snapshot, and manifest entries retain their
current archive representation. ZIP entry names and project format version do
not change.

The archive is written to the existing sibling temporary path. The writer
finishes and closes the ZIP, flushes the file, and performs basic archive
validation before atomically replacing the destination. Any error deletes the
temporary file and preserves the previous project file.

For Save As, the in-memory project path and display name change only after the
new archive has passed validation and atomic placement. A failed Save As leaves
both the previous file and current project identity unchanged.

### Save Progress Contract

The asynchronous Tauri command emits throttled progress events:

```ts
interface SaveProgress {
  phase: "preparing" | "table" | "metadata" | "compressing" | "finalizing";
  tableIndex: number;
  tableTotal: number;
  tableName?: string;
  rowsDone: number;
  rowsTotal: number;
  overallProgress?: number;
}
```

While work is advancing, regular events are no more frequent than every 100 ms
and no less frequent than every 250 ms. Phase-transition and completion events
are mandatory regardless of that throttle. Event failure does not fail the
save.

The frontend enters a global read-only state before invoking save. It keeps
navigation, scrolling, zooming, and read-only queries enabled while disabling
editing, deletion, imports, schema changes, graph configuration changes, and
other project mutations. Success clears dirty only after atomic replacement.
Failure displays the error, preserves dirty, and always exits read-only state.

## Error Handling

### Graph Builder

- Invalid bindings or filters return `AppError::InvalidParam`.
- Database and encoding failures use the existing mapped `AppError` variants.
- Generation mismatch and cancellation are distinct from user-visible query
  failures and do not replace the current graph with an error state.
- Memory budget failures are explicit. They never enable Sampling implicitly.
- Full Data response metadata is checked before committing the final frame.

### Project Save

- A concurrent save returns a specific busy error.
- Mutations attempted during save return a read-only/busy error.
- Read, serialization, compression, flush, validation, and rename errors all
  preserve the prior project file.
- Temporary files are cleaned up on every recoverable failure path.
- Losing a progress listener does not cancel or fail a save.
- Application shutdown during an incomplete save leaves the previous archive
  valid and a removable temporary file.

## Testing Strategy

### Common Scale Matrix

Graph and save correctness suites use the same parameterized sizes:

```text
0, 1, 10, 5,000, and 300,000 rows
```

Tests assert that the request, response, renderer input, save writer, progress,
and error path do not change with scale.

### Graph Tests

- Projection includes only required source columns and `_row_id` when needed.
- Full Data returns every valid filtered row exactly once across chunk edges.
- Numeric buffers, dictionaries, validity bitmaps, and row IDs round-trip.
- Sampling is absent by default and enabled only by an explicit request.
- Equal seed and input produce equal stratified samples.
- Histogram, heatmap, box plot, summary, and interval packets match direct
  DuckDB reference SQL over all filtered rows.
- Cancellation and stale generation cannot commit old chunks.
- Canvas coordinate and pixel-digest fixtures cover categorical and continuous
  axes, facets, zoom, missing values, and overpainting.
- Hover and click resolve source row IDs without per-point ECharts objects.

### Save Tests

- Empty, small, multi-table, complex-type, BLOB, and 300,000-row projects all
  use the streaming writer.
- Reopening a saved archive preserves values, row order, display properties,
  graphs, tabulates, folders, history, and snapshots.
- Batch boundaries do not duplicate or omit rows with gapped `_row_id` values.
- Read queries complete between save batches.
- Every mutation entry point rejects work while the save guard is active.
- Progress is monotonic, phase transitions are ordered, and completion occurs
  exactly once.
- Injected read, write, compression, flush, and rename failures preserve the
  previous archive and clear the save guard.

## Performance Acceptance Criteria

Measurements use release builds, the existing 300,000-row project, identical
graph configuration, and the same machine for baseline and optimized runs.
Cold and warm results, wall time, peak working set, transferred bytes, and
WebView long tasks are recorded.

### Graph Builder

For the Full Data `region` by `cost` Points graph:

- Sampling is disabled and all 300,000 valid rows are processed.
- The backend reads only `_row_id`, `region`, and `cost`.
- Warm time to the first complete frame is at most 1 second.
- Cold time to the first complete frame is at most 2 seconds.
- Field changes cause no continuous WebView main-thread stall over 200 ms.
- Zoom and pan remain continuously perceptible without rebuilding 300,000
  JavaScript point objects.
- Peak incremental memory is at least 50 percent lower than the old path.

### Project Save

- The operating system and WebView do not report the application as
  unresponsive.
- Progress remains visibly active within the 100-250 ms event cadence.
- Open table scrolling remains usable and new read-only window queries finish.
- No allocation proportional to a complete `TableDoc` plus complete serialized
  JSON exists.
- Additional peak memory for the 300,000-row reference project is below 100 MB.
- Wall time improves by at least 50 percent from the measured old-path baseline.
- If storage or deflate throughput becomes the limiting factor, responsiveness,
  bounded memory, correctness, and accurate progress remain mandatory.

## Delivery Phases

1. Add cold/warm graph and save benchmarks around the current implementation.
2. Introduce the unified Graph Data request, validation, projection, and typed
   chunk contract.
3. Implement the unified raw-points renderer and interaction index.
4. Move filtering and exact aggregate elements to `GraphDataService`.
5. Remove the production full-table `GraphData` preparation route.
6. Add `SaveCoordinator`, mutation guards, async command, and progress events.
7. Replace `TableDoc` materialization with the streaming archive writer.
8. Add frontend read-only save state and progress UI.
9. Run the common scale matrix and real-project performance comparison.
10. Profile any missed target and optimize buffer encoding, Canvas raster work,
    or ZIP compression inside the same pipeline.

## Completion Criteria

The work is complete when both features use their unified pipelines at every
data size, all correctness and failure-injection tests pass, the 300,000-row
reference workload meets the performance gates, existing project archives
remain readable, and no production fallback silently changes data semantics.