# Data SQL Query Design

## Goal

Add a top-level `Data` menu with a SQL Query workspace that lets users run
read-only DuckDB queries against project tables by their visible names, preview
paginated results, and explicitly create a managed data table from a successful
query.

The project model will also make Directory folders presentation-only metadata.
Tables and graphs retain stable ID-based archive paths, while the backend
enforces globally unique table names. This gives SQL a flat, unambiguous table
namespace that does not change when an item moves between UI folders.

## Product Scope

The first version supports:

- One read-only `SELECT` or `WITH ... SELECT` query at a time.
- Direct references to globally unique visible table names.
- A 200-row paginated result preview with total row count and execution time.
- Explicit creation of a new managed data table from a successful query.
- Joins, aggregations, DuckDB expressions, and other syntax valid inside a
  DuckDB query expression.

The first version does not support data-changing SQL, multiple statements,
query history, saved query documents, or arbitrary DuckDB administration
commands.

## Project And Folder Model

Directory folders organize tables and graphs in the frontend only. Folder
placement does not participate in DuckDB table identity, SQL name resolution,
or archive entry paths.

Newly saved projects use stable archive paths:

```text
manifest.json
tables/<dataset-id>.sptb
graphs/<graph-id>.spgh
.history.json
.snapshots.json
```

The project manifest persists folder state independently:

```json
{
  "folders": ["Raw", "Reports/Monthly"],
  "tableFolders": {
    "<dataset-id>": "Raw"
  },
  "graphFolders": {
    "<graph-id>": "Reports/Monthly"
  }
}
```

Folder paths continue to use `/` as their logical separator. Folder names must
be unique within one parent folder but may repeat under different parents.
Renaming, moving, or deleting a folder updates only folder metadata and never
renames or relocates the underlying table or graph archive entry.

Tables and graphs may share a display name because graphs are not part of the
SQL namespace. Table names alone are globally unique within a project using a
case-insensitive comparison consistent with DuckDB identifier resolution.

### Project Compatibility

The reader continues to accept the current path-based archive format. When a
manifest lacks explicit `tableFolders` or `graphFolders`, the loader derives
the assignments from each entry's archive path. The in-memory project then uses
the new independent folder maps. Its next save writes stable ID-based archive
paths and explicit folder mappings.

When an older project contains duplicate table names, loading keeps the first
name in stable manifest order and suffixes later names as `Name (2)`,
`Name (3)`, and so on. Comparison is case-insensitive. The frontend reports
that duplicate names were migrated and marks the project dirty so the user can
save the normalized names. Dataset and graph relationships remain intact
because they use dataset IDs.

## Global Table Name Invariant

The backend owns table-name validation. Every path that creates or changes a
dataset name uses the same validation routine:

- Empty or whitespace-only names are rejected.
- Existing filesystem-safe display-name validation remains in force.
- A case-insensitive match with another dataset is rejected.
- A dataset being renamed is excluded from its own conflict check.

This validation applies to blank table creation, file import, standalone table
import, project load normalization, rename, table operation outputs, and SQL
query outputs. Frontend checks may provide immediate feedback, but backend
validation remains authoritative.

New table creation proposes a non-conflicting default name. User-entered
conflicts are not silently overwritten or redirected to another folder; the
operation returns an `InvalidParam` error naming the conflict.

## SQL Name Resolution And Read-Only Boundary

Internal DuckDB tables keep their `dataset_<uuid>` names. During one SQL query
operation, the backend creates quoted temporary views mapping every visible
dataset name to its internal table. These aliases exist only while the shared
DuckDB connection is locked for that operation and are removed on both success
and failure.

For example, the project table `Sales 2026` is queried as:

```sql
SELECT region, sum(revenue)
FROM "Sales 2026"
GROUP BY region
```

The backend does not expose internal UUID table names, metadata tables, or
absolute source paths to the frontend.

User SQL passes an AST allowlist before DuckDB prepares it. The Rust backend
uses `sqlparser-rs` with its DuckDB dialect and requires exactly one top-level
`Statement::Query`. Every relation is visited recursively: a normal table
reference must match a globally unique project table alias or a CTE defined in
the current query scope; derived subqueries are recursively validated; system
schemas, table functions, dynamic query functions, and all other relation
sources are rejected. This also rejects data-changing statements, DDL, `COPY`,
`ATTACH`, `PRAGMA`, and multiple statements without relying on keyword scans.

While the shared DuckDB connection is locked for a user query, external access
is disabled as defense in depth and restored during cleanup. Preview, counting,
and table creation then place the validated expression inside an outer
relational query. The query text is never used to construct an identifier;
generated identifiers are separately quoted and validated.

AST validation, temporary alias creation, external-access configuration, query
preparation and execution, and cleanup are owned by one engine-level helper so
preview and table creation enforce the same boundary. Cleanup errors do not
replace a more useful original query error, but are returned when cleanup is
the only failure.

## Backend Architecture

The Rust model adds a camelCase-serialized SQL result containing:

- `columns`
- `columnTypes`
- `rows`
- `totalRows`
- `page`
- `pageSize`
- `executionTimeMs`

Two Tauri commands are added:

```text
execute_sql_query(sql, page, page_size) -> SqlQueryResult
create_table_from_sql_query(sql, name) -> DatasetMeta
```

Command handlers remain thin and delegate to `DataService`. `DataService`
locks the shared engine and delegates query execution, validation, and table
creation to `DuckDbEngine`.

`execute_sql_query` uses a fixed page size of 200 at the product layer. The
backend still validates `page_size` and caps it at 200 so IPC callers cannot
bypass the limit. It executes an outer `COUNT(*)` query for `totalRows` and an
outer `LIMIT`/`OFFSET` query for the requested page. Page arithmetic is checked
for overflow.

`create_table_from_sql_query` reruns the approved query rather than trusting
frontend preview data. In one transaction it:

1. Revalidates the requested globally unique table name.
2. Creates the UUID-named internal table from the complete query result.
3. Adds the managed `_row_id` column expected by table editing workflows.
4. Reads the resulting DuckDB column names and types.
5. Inserts `_meta_datasets` and `_meta_columns` records.
6. Commits only when all table and metadata work succeeds.

Any failure rolls back the internal table and metadata together. The source
type for a query-created table is `query`, and the TypeScript `DatasetMeta`
union is extended accordingly.

## Frontend Architecture

The top menu order becomes `File | Table | Data | Graph | Help`. The `Data`
menu contains `SQL Query...`, which opens `SqlQueryDialog`.

SQL Query is a large modal with a stable desktop-tool layout:

- A narrow left pane lists available tables and their UI folder paths.
- Double-clicking a table inserts its correctly quoted visible name at the
  editor cursor.
- The upper right pane contains a resizable monospaced SQL editor.
- A compact toolbar provides Run, Clear, Create Table, and Close commands.
- `Ctrl+Enter` or `Cmd+Enter` runs the query.
- The lower right pane contains a read-only result grid.
- A footer shows total rows, execution time, current page, and previous/next
  controls.

The result grid has stable column widths, scrolls in both directions, displays
DuckDB types with column headers, and renders null distinctly from an empty
string. It does not reuse `DataTableView` because that component owns editing,
selection, history, display properties, and dataset-specific operations that
do not apply to transient query results.

Dialog state is local because SQL text, transient rows, pagination, busy state,
and errors are not shared application state. Dataset metadata comes from
`useDataStore`. IPC calls are wrapped by `dataService`, and TypeScript result
types mirror the Rust models.

Run clears any previous query error and replaces the result only after a
successful response. A failed new query clears an older result so stale data
cannot be mistaken for the latest execution. A failed page change preserves
the currently displayed successful page and reports the paging error.

Create Table is enabled only after a successful query. It opens a focused name
prompt with a non-conflicting default. On success, Workspace refreshes
datasets, selects the new table, closes the SQL dialog, marks the project dirty,
and records a history entry. On failure, the dialog and SQL text remain open.

All new labels and messages are added to English, Simplified Chinese,
Traditional Chinese, and Vietnamese locale files.

## Error Handling

- Empty SQL is rejected by the frontend and backend.
- Invalid syntax and unknown table or column names preserve DuckDB's useful
  message through `AppError::InvalidParam` or `AppError::Database` as
  appropriate.
- Non-query and multi-statement input returns `AppError::InvalidParam`.
- Duplicate table names identify the conflicting visible name.
- Query failure preserves SQL text and clears stale result data.
- Paging failure preserves the last successful page.
- Table creation failure does not refresh datasets, mark the project dirty, or
  record history.
- Project migration reports renamed duplicate tables once after load.

The first version does not add query cancellation. While a query runs, the
dialog disables execution and paging controls and shows a busy state. The
shared DuckDB mutex preserves connection consistency with existing commands.

## Testing And Validation

Rust engine and service tests cover:

- Simple `SELECT` and `WITH ... SELECT` queries.
- Joins and aggregation through visible table aliases.
- Names containing spaces and non-ASCII text.
- Rejection of empty SQL, multiple statements, DML, DDL, `COPY`, `ATTACH`, and
  `PRAGMA`.
- Rejection of metadata/system schemas, table functions, dynamic query
  functions, and unknown relation names.
- Acceptance of project-table references, nested CTEs, derived subqueries, and
  joins after recursive AST validation.
- External access is disabled during execution and restored after success or
  failure.
- Correct total count and 200-row pagination.
- Page and offset validation.
- Case-insensitive global table-name uniqueness across creation and rename
  paths.
- Complete query-result table creation, `_row_id`, metadata, and source type.
- Transaction rollback when result-table metadata creation fails.
- Temporary alias cleanup after success and failure.

Project archive tests cover:

- Stable `tables/<dataset-id>.sptb` and `graphs/<graph-id>.spgh` paths.
- Explicit folder maps in the manifest.
- Folder moves that do not change archive entry paths.
- Reading the previous path-based format and preserving folder assignments.
- Duplicate-name migration with deterministic suffixes.
- Save and reload after migration.

Frontend validation covers:

- TypeScript and Vite production build.
- Data menu placement and localized labels.
- SQL execution, busy, empty, error, and success states.
- Result pagination and null rendering.
- Table-name insertion and identifier quoting.
- Creating a dataset from a successful query and selecting it in Directory.

The repository has no frontend UI test runner, so interactive behavior is
verified in the Tauri development application. Final executable checks are:

```powershell
npx vite build
Set-Location src-tauri
cargo test
cargo clippy -- -D warnings
```