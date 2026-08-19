# Big Data Performance Design

## Goal

Make StatsPlayground responsive and predictably fast with tables containing
hundreds of thousands of rows. The application must stop moving complete
managed tables through JSON IPC or retaining complete tables in React state.
DuckDB must own bulk storage, filtering, sorting, aggregation, and mutation.

The reference workload is 100,000 rows by 20 columns on a modern laptop with
an NVMe SSD. A 500,000-row workload is the pressure tier. Benchmarks use a
release build; development builds are diagnostic only.

## Performance Targets

For the 100,000 by 20 reference workload:

- Cold project open to the first visible table page: under 2 seconds.
- Switching between already-open tables: under 300 ms.
- Cached or adjacent viewport fetch P95: under 100 ms.
- Paste 100,000 rows by 10 columns: under 5 seconds.
- Simple filter, projection, or grouped aggregate: under 1 second.
- Project save: under 3 seconds.
- No main-thread stall longer than 100 ms during backend work.
- The frontend retains at most 5,000 table rows for one table viewport.
- Frontend table memory does not grow linearly with total dataset row count.

For 500,000 rows, open, save, and bulk paste may take 5-15 seconds, but the UI
must remain responsive and report progress. Results are regression thresholds,
not guarantees for arbitrary SQL complexity or unusually wide string data.

## Current Bottlenecks

The current application uses an in-memory DuckDB guarded by one global mutex.
The table view requests up to 1,000,000 rows, serializes them as nested JSON,
and stores the complete result in React. Table history clones that complete
result after ordinary operations. Filtering and graph preparation also assume
that every row is present in the WebView.

Read-only SQL creates a new in-memory DuckDB for every request and copies every
visible dataset into it one row at a time before planning and running the user
query. Preview then computes an exact count and executes the page query.

Project v3 stores every table as row-oriented JSON inside a ZIP archive. Open
materializes all table documents and inserts each row into a new in-memory
DuckDB. Save performs the inverse conversion. Peak memory therefore includes
DuckDB storage, JSON trees, IPC buffers, and compression buffers at once.

Excel paste is one IPC call, but the WebView parses, scans, and type-infers the
entire TSV. Rust then inserts patch rows one at a time before a set-based
update. The frontend reloads and clones the complete table after the paste.

These paths are dominated by serial row conversion, allocation, IPC, and lock
wait rather than vectorized DuckDB execution. Low aggregate CPU usage is
therefore expected on a many-core processor.

## Target Architecture

### File-Backed Working Database

Each open project uses a file-backed DuckDB working database. `AppState` owns a
`ProjectDatabase` abstraction rather than a mutex around one in-memory
connection. The abstraction provides:

- One serialized writer connection for schema and data mutations.
- A small bounded pool of read connections for table pages, SQL, statistics,
  and graph queries.
- A generation number that invalidates stale viewport and query responses after
  a mutation or project switch.
- Explicit checkpoint, close, replace, and cleanup operations.

Opening a v4 project copies the project file to an application cache location
and opens the working copy. User edits affect only the working copy until Save.
Save checkpoints the working database, copies it to a sibling temporary path,
flushes it, and atomically replaces the selected project file. Save As uses the
same path. Closing or replacing a project removes the cache copy after all
connections and tasks have stopped.

DuckDB external access is disabled when connections are created. Query threads,
connection count, and memory limits are configured centrally and measured in
benchmarks rather than hard-coded independently by each feature.

### `.spprj` Version 4

A v4 `.spprj` is a DuckDB database file with the existing extension. It stores:

- Managed dataset tables using their stable UUID-based internal names.
- Dataset and column metadata.
- Project metadata and format version.
- Folder assignment metadata.
- Graph and tabulate documents as JSON metadata rows.
- History metadata and references to database-backed change sets.

The reader detects v1-v3 ZIP/JSON files by their file signature. It imports the
legacy bundle into a temporary v4 database in one transaction, reports
progress, and leaves the original file untouched. The migrated project becomes
v4 only when the user saves it. A migration failure deletes the temporary v4
database and preserves the currently open project.

A standalone `.sptb` v3 becomes a ZIP containing a small JSON manifest and a
Parquet payload. Existing JSON `.sptb` versions remain readable. DuckDB writes
and reads the Parquet payload directly so standalone table transfer is also
columnar and vectorized.

### Server-Side Table Windowing

The table IPC contract becomes window-based. A request identifies:

- Dataset ID.
- Stable sort specification.
- Filter expression tree.
- Zero-based start row or continuation cursor.
- Requested row count, capped by the backend.
- Dataset generation expected by the caller.

A response contains:

- Column metadata.
- A bounded row window including stable `_row_id` values.
- Total filtered row count when already known, otherwise an optional count.
- Start position or continuation cursor.
- Current dataset generation.

The initial implementation may use offset paging for correctness, but the
public contract must permit keyset or cursor paging. Natural table order is
`_row_id`. Sorted windows use deterministic tie-breaking by `_row_id`.

`DataTableView` keeps a bounded page cache with an upper limit of 5,000 rows.
Virtual scroll coordinates represent the logical result size, while only the
visible window and adjacent windows exist as JS row arrays. Stale responses are
ignored when dataset ID, query generation, filter, or sort changes.

Selection is represented as row IDs, ranges, or a query-backed selection token;
it is never expanded into a JS set containing every selected cell. Whole-table
copy/export is a backend streaming operation, not a traversal of frontend rows.

### Filter, Sort, And Distinct Values

The existing filter model remains the product contract, but Rust translates it
to parameterized DuckDB predicates. Generated identifiers are validated against
column metadata and quoted; values are bound parameters. Sort follows the same
rules.

Distinct categorical values are fetched through a dedicated grouped query with
a backend cap. Filtered counts and summaries are backend queries. Frontend
filter evaluation remains only for small transient graph results and tests; it
is not used for managed table browsing.

### Incremental History

Ordinary table actions no longer capture `structuredClone` of a full table.
History entries contain typed inverse operations:

- Cell edit: row ID, column, old value, new value.
- Row insertion/deletion: affected row payloads or a database change-set ID.
- Paste: affected rectangle plus a database-backed before-image table.
- Schema operation: inverse schema operation and required metadata.
- Derived-table creation: created dataset ID.

Large before-images are stored in internal DuckDB history tables and referenced
by ID. History has configurable entry and byte budgets. Eviction deletes both
metadata and referenced change-set rows. Named project snapshots use database
checkpoints or database-file copies, never complete row JSON sent to the
frontend.

### SQL Query Sessions

Read-only SQL runs on a read connection to the working database. The connection
creates TEMP views mapping globally unique visible table names to internal UUID
tables. No dataset rows are copied.

The existing recursive AST relation allowlist remains authoritative. External
access remains disabled for the complete connection lifetime. Internal table
names and metadata schemas are rejected even if supplied directly.

Fast preview executes a bounded page and returns `hasMore`; exact total count is
optional and computed only on demand or in a cancellable background request.
When users page repeatedly or request materialization, the backend may create a
query-session TEMP result table and return an opaque session ID. Session tables
have an idle timeout and are dropped on dialog close, query replacement,
project switch, or application shutdown.

Creating a managed table from SQL uses one DuckDB `CREATE TABLE AS SELECT` in
the writer connection, followed by metadata registration in the same
transaction. It never materializes the complete result in Rust.

### Vectorized Paste

The frontend sends raw clipboard TSV, target location, header mode, and expected
dataset generation. Rust performs streaming TSV parsing and bounded type
inference. The backend checks conflicts with set-based SQL.

Patch data is loaded with DuckDB Appender, COPY, or bounded multi-row batches;
there is no per-cell IPC and no one-statement-per-row loop. One transaction
allocates missing rows, applies the patch, records the history before-image,
updates metadata, and increments the dataset generation.

The response contains the new generation, affected logical range, and updated
row/column counts. The frontend invalidates only intersecting cached pages.
Bulk paste is asynchronous, emits progress, supports cancellation before
commit, and always clears busy state.

### Graphs And Statistics

Managed-table graph requests describe required fields, grouping, filters, and
visual sampling budget. DuckDB performs projection, aggregation, and filtering.
The frontend receives only the result needed to draw the chart.

Scatter plots use deterministic sampling above a point budget. Lines use
bucket aggregation or LTTB downsampling. Histograms, summaries, box plots, and
grouped counts are computed in DuckDB. Full raw rows cross IPC only for an
explicit export operation.

### Concurrency And Responsiveness

All filesystem, migration, bulk mutation, and SQL operations run outside the
WebView event thread. Commands return request IDs where cancellation is useful.
Only the writer is serialized; readers use bounded independent connections.
Project switch waits for or cancels tasks from the previous generation.

Progress events are throttled to avoid flooding the Tauri event channel. Errors
retain the current project and clear UI busy state. No Rust lock guard is held
while emitting events or awaiting frontend work.

## Delivery Sequence

### Phase 0: Benchmarks And Observability

Add deterministic data generators and Rust integration benchmarks for 100,000
and 500,000 rows. Instrument lock wait, parsing, DuckDB execution, serialization,
and total command time. Add a frontend development counter that records rows
and estimated bytes retained in the viewport cache.

### Phase 1: Bounded Table Data And Incremental History

Introduce filter/sort/window request models, backend bounded queries, and the
frontend page cache. Migrate table browsing, editing, selection, distinct value
loading, and history away from complete row arrays. Preserve current behavior
for visible rows and route whole-table operations to backend commands.

### Phase 2: File-Backed v4 Projects

Implement `ProjectDatabase`, v4 schema creation, cache working copies, atomic
save, and v1-v3 migration. Keep legacy readers but stop writing v3. Add crash,
failed migration, and atomic replacement tests.

### Phase 3: Direct SQL Sessions

Replace isolated row-copy snapshots with restricted read connections and TEMP
visible-name views. Add fast preview, optional exact count, cancellation, query
session cleanup, and `CREATE TABLE AS SELECT` materialization.

### Phase 4: Vectorized Paste And Import

Move TSV parsing to Rust, use vectorized patch ingestion, record database-backed
before-images, invalidate bounded pages, and migrate `.sptb` to manifest plus
Parquet. Apply the same ingestion primitive to SQLite and CSV where practical.

### Phase 5: Query-Backed Graphs And Statistics

Move graph filtering, aggregation, statistics, sampling, and downsampling behind
backend query contracts. Remove remaining managed-table full-row fetches from
the WebView.

### Phase 6: Tuning And Hardening

Tune DuckDB threads, connection count, memory limits, checkpoint frequency, and
Rust release optimization from benchmark evidence. Add cancellation stress,
concurrent read/write, low-memory, crash recovery, and 500,000-row acceptance
runs.

## Testing Strategy

Every phase begins with a failing behavior or performance regression test.
Correctness suites use small fixtures; performance suites generate data in
DuckDB without shipping it through JSON.

Required coverage includes:

- Window boundaries, deterministic ordering, stale generation rejection, and
  bounded frontend cache eviction.
- Filter translation equivalence with current filter semantics.
- Undo/redo correctness for edits, paste, row operations, and schema changes.
- Legacy v1-v3 migration, failed migration atomicity, v4 save replacement, and
  reopen fidelity for scalar and complex DuckDB types.
- SQL relation isolation, external-access denial, query cancellation, session
  cleanup, and concurrent reads during ordinary browsing.
- Large paste atomicity, type inference, conflict behavior, progress throttling,
  and cancellation rollback.
- Graph sampling determinism and aggregate equivalence.

Performance tests report timings and memory, but CI uses conservative regression
ratios where hardware-independent absolute limits are unsuitable. Release
acceptance runs use the target machine class and the explicit thresholds above.

## Compatibility And Non-Goals

- Existing v1-v3 `.spprj` and JSON `.sptb` files remain importable.
- Saving a migrated project writes v4; v4 is not expected to open in older app
  versions.
- Folder and visible table semantics remain unchanged.
- SQL stays read-only at the user boundary.
- This work does not make arbitrary charts render millions of points; it makes
  sampling and aggregation explicit.
- This work does not promise constant-time arbitrary OFFSET pagination; the
  contract permits cursor migration where required.
- Changing only compiler flags, adding loading overlays, or increasing DuckDB
  thread count is not considered completion of the performance work.

## Rollout And Safety

Each phase ships behind stable IPC contracts and retains migration fallbacks
until the next phase is verified. Benchmarks are captured before and after each
phase. No phase may regress legacy project fidelity, SQL isolation, or atomic
project replacement in exchange for speed.
