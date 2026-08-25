# Long-Term Graph Performance Evaluation

## Decision To Make

StatsPlayground has designs for a file-backed DuckDB project format and a typed
columnar Graph Builder pipeline. Both are substantial migrations. Before
implementation, measure whether each proposed layer addresses the stages that
actually dominate Graph Builder complete-frame latency and memory.

This document defines an evaluation, not a production migration. The full
typed pipeline and `.spprj` v4 work proceed only after measured evidence meets
the decision gates below.

## Hypotheses

### File-Backed DuckDB

Making the project working database persistent should materially improve project
open, save, and database lifetime behavior by removing JSON restore/export work.
It may reduce graph query startup and benefit operating-system page-cache reuse.
It is not expected by itself to remove frontend transform or ECharts rendering
cost, so it must not be presented as a standalone rendering optimization.

### Projection-First Typed Columnar IPC

Selecting only X, Y, row ID, group/facet, filter, and enabled-element fields
should reduce query conversion and transfer volume. For a `300,000 x 20` table
whose scatter plot needs X, Y, and `_row_id`, the number of transferred cells
falls from approximately 6,000,000 to 900,000 before accounting for the further
benefit of typed binary encoding.

Typed numeric buffers, categorical dictionaries, and validity bitmaps should
avoid per-cell JSON values and nested `unknown[][]` allocation. The expected
benefits are lower IPC bytes, decode time, garbage-collection pressure, and
peak WebView memory.

### Direct Typed-Buffer Rendering

If ECharts point-object construction and `setOption` dominate after projection,
typed IPC alone will not meet the complete-frame target. A Canvas points layer
that consumes typed buffers directly should avoid one JavaScript/ECharts object
per observation while retaining Full Data semantics. This hypothesis requires
a narrow vertical prototype before any full renderer migration.

## Baseline Instrumentation

Add opt-in performance instrumentation that records one request ID across these
stages:

1. generation and metadata lookup;
2. DuckDB query/fetch;
3. Rust JSON encoding and IPC handoff where observable;
4. WebView response completion and row accumulation;
5. `buildGraph` option construction;
6. ECharts `setOption` call duration;
7. ECharts `finished` complete-frame time;
8. total user activation to complete frame;
9. WebView main-thread tasks over 200 ms;
10. backend and WebView peak working set where measurable.

All measurements report row count, column count, requested fields, transferred
bytes, panel count, enabled elements, Full/Sample mode, and whether the
session hot cache hit. Development instrumentation must be disabled by default
and must not change production graph semantics.

## Benchmark Matrix

Use deterministic `300,000 x 20` data on the recorded Windows/NVMe machine.
Sampling is off and every valid Full Data observation must be represented.

Measure at least:

1. X/Y numeric scatter with `_row_id` selection metadata;
2. single-numeric-column histogram;
3. numeric value plus categorical group box plot;
4. faceted X/Y scatter with a bounded, repeatable panel count.

For each graph record:

- first open after project load;
- cold Graph Builder load without a session-cache entry;
- warm completed-data cache hit;
- field or element change using already loaded data;
- project close/reopen where applicable.

Run at least five measured repetitions after one warm-up and report median,
P95, transferred bytes, and peak memory. Retain raw machine-readable results in
the performance documentation.

## Vertical Prototype

Build one non-production X/Y scatter path behind an explicit development flag:

- validate generation before expensive work;
- project exactly X, Y, and `_row_id` from DuckDB;
- encode ordered typed columnar chunks;
- decode without constructing row-oriented cell objects;
- draw every valid point in requestAnimationFrame batches on a Canvas layer;
- retain ECharts only for axes, layout, labels, and interactions needed by the
  comparison;
- report processed rows and reject stale/cancelled chunks.

The prototype does not change project format, become a production fallback,
add automatic sampling, or implement all chart types. Its purpose is to measure
the maximum credible benefit of the proposed graph data and raw-points path.

## Comparison Groups

Compare the same Full Data scatter through:

1. current all-column JSON plus ECharts path;
2. current path with animation disabled;
3. projected typed-column data adapted back into ordinary ECharts point
   objects;
4. projected typed-column data drawn directly from buffers.

This isolates animation, transfer/decode, object construction, and renderer
cost. A file-backed DuckDB prototype, if evaluated, is measured separately
against project open/save and query stages rather than credited with frontend
draw improvements.

## Decision Gates

For the `300,000 x 20` Full Data X/Y scatter prototype:

- processed rows equal 300,000; no implicit sampling or dropped valid rows;
- cold activation to coherent complete frame is at most 2 seconds;
- completed session-cache re-entry is at most 300 ms;
- no single avoidable WebView main-thread task exceeds 200 ms;
- the typed direct-render path improves median cold complete-frame time by at
  least 50 percent over the current animation-disabled path;
- transferred bytes and peak working set are lower than the current path;
- point selection can resolve stable source row IDs;
- cancellation and generation mismatch cannot commit stale frames.

If typed IPC improves transfer/decode but not complete-frame time, renderer work
must be included in any production proposal. If direct rendering does not meet
the 50 percent gate, do not undertake the full renderer migration without a new
measured justification.

File-backed DuckDB is approved independently only if project open/save and
database lifecycle benchmarks justify its migration cost. It is not blocked by
a renderer result, but its business case must use the stages it actually
improves.

## Production Migration Boundary

After the evaluation, write a new implementation spec using recorded results.
That spec must identify which stages are changing, preserve one pipeline for all
row counts, retain Full Data as the default, define binary transport supported
by the pinned Tauri version, and include migration compatibility for existing
projects. This evaluation document does not authorize those changes by itself.
