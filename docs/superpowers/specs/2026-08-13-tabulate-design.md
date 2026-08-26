# Tabulate Design

**Date:** 2026-08-13
**Status:** Approved design, pending written-spec review

## Goal

Add `Analyze > Tabulate`, a JMP-inspired interactive cross-tabulation workspace
for rapidly exploring an active dataset without creating or modifying data
tables.

Tabulate must remain useful for datasets too large to load into the frontend.
DuckDB performs grouping and aggregation; React receives only a normalized
result matrix and renders it as a hierarchical table.

## Scope

The first release includes:

- A new `Analyze` menu containing `Tabulate`.
- Saved Tabulate analysis items bound to one source dataset.
- A three-column workspace with source fields, role drop zones, and results.
- Multiple ordered row and column dimensions.
- Multiple statistics for the same measure field.
- Live, non-destructive results with row and column totals.
- Project persistence for analysis names and configurations.

The first release does not create a result dataset, edit source data, accept
user-authored SQL, or export a Tabulate result.

## User Experience

### Entry And Workspace Ownership

`Analyze > Tabulate` is enabled only when a dataset is active. Invoking it
creates a uniquely identified analysis named `Tabulate N`, binds it to the
active dataset, adds it to the Directory, and opens it in the main workspace.

A Tabulate analysis is a sibling of tables and graph builders in workspace
navigation. It can be selected, renamed, moved into a Directory folder, and
deleted using the same interaction patterns as existing workspace items.

Deleting the source dataset does not silently delete the analysis. The saved
analysis remains visible and reports that its source dataset is unavailable.

### Three-Column Layout

The selected layout follows the JMP-style three-column arrangement:

1. **Fields:** searchable source columns with data type and modeling-role cues.
2. **Build:** ordered `Rows`, `Columns`, and `Statistics` drop zones.
3. **Results:** the live hierarchical cross-tabulation.

The Build column has a stable width. The Fields column can be collapsed, and
the Results column consumes the remaining width. Narrow windows automatically collapse
Fields but must not change the role-zone ordering.

### Field Assignment

Users can drag source fields into role zones. Double-clicking a nominal,
ordinal, or ID field adds it to `Rows`; double-clicking a continuous field adds
it to `Statistics` with `Mean` as its initial statistic.

Rows and Columns accept multiple fields. Their displayed order defines the
nesting order from outermost to innermost. Entries can be reordered or removed.

Statistics contains entries identified independently from source fields, so
one field can appear multiple times with different statistics. Clicking an
entry opens its statistic selector and, for quantiles, its probability input.

At least one statistic is required before a query runs. Empty role zones show
concise drop targets rather than executing an implicit query.

### Statistics

The supported statistics are:

- Count
- Missing count
- Unique value count
- Sum
- Mean
- Standard deviation
- Variance
- Minimum
- Maximum
- Median
- Range
- Quantile with a configurable probability from 0 through 1
- Row percentage
- Column percentage
- Total percentage

Count, missing count, unique value count, and percentages can be applied to any
field. Numeric statistics are available only for compatible numeric fields.
Invalid field/statistic combinations are disabled in the UI and rejected at
the backend boundary.

Percentage entries use the selected field's non-missing count as their base
measure. Row percentage divides each interior cell by the corresponding row
total, column percentage divides by the corresponding column total, and total
percentage divides by the grand total. A zero denominator produces a null
result rather than infinity or zero.

### Result Table

The Results column renders nested column headers and nested row labels. Header
and row-label regions remain frozen while values scroll. Users can expand or
collapse the globally visible row and column depth and independently show or
hide row totals and column totals. Collapsing a depth reruns the query with the
visible outer field prefix so displayed values are true aggregates; it does
not remove fields from the saved role configuration.

Missing dimension values form an explicit localized `Missing` member. Null
measure results display as an em dash. Raw numeric values cross IPC; display
formatting is applied by the frontend. Numeric statistics inherit compatible
source-column formatting, while percentage statistics use percentage format.

Configuration changes wait 250 milliseconds before starting a query. The last
valid result remains visible with a lightweight loading treatment. Each request
has a monotonically increasing frontend sequence number; only the latest
request updates the displayed result or error.

## Data Model

### Saved Analysis

The frontend stores a `TabulateItem` with:

- Stable ID and display name.
- Source dataset ID.
- Ordered row and column field names.
- Ordered statistic entries, each with a stable entry ID, field name,
  statistic kind, and optional quantile probability.
- Row-total and column-total visibility.

Tabulate items use a dedicated Zustand store following the graph-builder store
pattern. Project save and open serialize the items as opaque JSON alongside
graph builders. Directory folder assignment uses a dedicated analysis-folder
map keyed by Tabulate item ID rather than encoding folder names into item data.

### Query Contract

The frontend sends a typed `TabulateRequest` containing the dataset ID, ordered
row fields, ordered column fields, statistic specifications, total options, and
the maximum allowed result-cell count.

The backend returns a typed `TabulateResult` containing:

- Ordered row members as arrays of nullable scalar labels.
- Ordered column members as arrays of nullable scalar labels.
- Ordered statistic descriptors.
- Raw nullable cell values in a deterministic flattened order.
- Optional row totals, column totals, and grand totals.
- The computed result-cell count and configured limit.

Rust models use `#[serde(rename_all = "camelCase")]`; TypeScript interfaces
mirror them exactly. Labels and values remain structured data rather than
preformatted strings.

## Backend Architecture

### IPC And Service Boundary

A thin `tabulate` Tauri command delegates to a dedicated service and is
registered in `tauri::generate_handler!`. A typed frontend service wrapper is
the only component that calls `invoke<TabulateResult>()`.

The service validates all request fields before querying DuckDB:

- The dataset exists.
- Role and measure fields exist in that dataset.
- Statistic kinds are known.
- Numeric statistics target compatible types.
- Quantile probabilities are finite and within the inclusive range 0 to 1.
- The requested result-cell limit equals the application limit.

Validation failures return `AppError::InvalidParam`; DuckDB execution failures
return `AppError::Database`. Production code does not use `unwrap()` or
`expect()`.

### Query Strategy

The service computes distinct grouped aggregates in DuckDB and returns a
normalized result rather than creating a physical or temporary project
dataset. The query is built only from validated statistic templates and quoted
identifiers resolved from dataset metadata. The frontend cannot provide SQL
fragments, function names, table names, or expressions.

Grouping order is deterministic: dimension members sort by DuckDB value order,
with missing members placed last. Result assembly preserves request order for
dimensions and statistics.

Percentages are derived from the same aggregate result and its row, column, or
grand totals so numerators and denominators share identical missing-value
semantics. Median and quantile use DuckDB aggregate functions. Standard
deviation and variance use sample definitions, matching the existing summary
operation unless that operation is changed project-wide in a separate task.

### Result Size Protection

The application-wide maximum is 10,000 interior result cells, defined as:

`row member count * column member count * statistic count`.

A missing row or column role contributes one synthetic member, so a one-axis
table still has a well-defined cell count. Totals do not count toward this
limit.

The backend determines grouped cardinalities before returning result values.
If the computed interior count exceeds the limit, it returns an invalid-
parameter error containing the count and limit. It does not return a truncated
table because truncation would present misleading totals and percentages.

## Frontend Components

The feature is divided into focused units:

- `TabulateView`: owns layout and binds the selected saved item to query state.
- `TabulateFieldList`: searchable draggable source fields.
- `TabulateRoleZone`: ordered field/statistic entries with reorder and remove.
- `TabulateStatisticEditor`: statistic kind and quantile configuration.
- `TabulateResultTable`: hierarchical headers, totals, scrolling, and formatting.
- `useTabulateStore`: saved item CRUD, counters, project hydration, and reset.
- Pure result helpers: hierarchy construction and flattened-cell lookup.

Components do not query Tauri directly. Query orchestration lives in the view
or a dedicated hook, while persistence and shared item state live in Zustand.

## States And Errors

The Results column has explicit states:

- **Unconfigured:** no statistics have been assigned.
- **Loading:** a query is active; the previous valid result remains visible.
- **Ready:** the latest request completed successfully.
- **Empty:** the valid configuration produced no grouped rows.
- **Source unavailable:** the bound dataset no longer exists.
- **Too large:** the result exceeds 10,000 interior cells and reports the
  calculated size.
- **Error:** validation or database execution failed; the configuration remains
  editable and retry occurs on the next valid change.

Errors are shown inside Results and do not close the analysis or discard the
last saved configuration.

## Localization And Accessibility

All visible strings are added to every locale with English fallback values.
Drop zones are operable without a pointer: focused fields can be assigned using
commands, role entries can be reordered using buttons, and remove/statistic
actions have accessible names. Drag feedback supplements rather than replaces
keyboard interaction.

The result uses semantic table markup where virtualization permits it. Frozen
headers preserve visible focus indicators, and loading/error states are
announced without repeatedly announcing every debounced request.

## Verification

### Rust Tests

Focused service and engine tests cover:

- One-axis and two-axis aggregation.
- Multiple nested row and column dimensions.
- Every statistic kind and repeated measures.
- Sample standard deviation and variance semantics.
- Quantiles at 0, 0.5, and 1.
- Missing dimensions and missing measures.
- Row, column, and total percentages, including zero denominators.
- Row totals, column totals, and grand totals.
- Deterministic ordering.
- Unknown datasets, unknown fields, incompatible field/statistic pairs, and
  invalid quantile probabilities.
- Exact-limit success and over-limit rejection.

### Frontend Tests

Pure TypeScript tests cover role-entry updates, hierarchy construction,
flattened-cell lookup, total placement, and request-sequence rejection. UI
behavior receives focused tests if the repository adds a component test runner;
otherwise it is verified through the production build and manual desktop test.

### Required Commands

- `npx vite build`
- `cargo build` in `src-tauri/`
- `cargo clippy` in `src-tauri/`
- `cargo test` in `src-tauri/`
- `cargo tauri dev` for manual creation, drag/drop, keyboard assignment,
  persistence, stale-response, and unavailable-source checks

## Acceptance Criteria

The feature is accepted when a user can select a data table, create a Tabulate
analysis from the Analyze menu, assign multiple nested row/column dimensions
and repeated statistics, and receive an accurate live cross-tabulation without
creating a dataset. The configuration survives project save/open, all size and
validation failures remain recoverable, and required frontend and backend
verification passes.