# CSV Import Row Identity Fix

## Problem

CSV import creates a DuckDB table containing only user columns. The bounded
table window and project serializer both require an internal `_row_id` column.
As a result, imported dataset metadata reports the correct shape while opening
the table falls back to an empty view and saving the project fails.

## Design

- Build imported CSV tables in one DuckDB statement with a generated,
  one-based `_row_id` and the CSV columns following it.
- Keep `_row_id` internal: `_meta_columns` and `col_count` continue to describe
  only user-visible CSV columns.
- Preserve natural CSV order by assigning IDs with `ROW_NUMBER() OVER ()` and
  using the existing `_row_id ASC` window order.
- Keep project serialization unchanged; once the import invariant is restored,
  its existing `_row_id` query works for imported tables.
- Surface a table-load failure in `DataTableView` instead of replacing it with
  a plausible empty table.

## Error Handling

If CSV parsing or table creation fails, import returns an `AppError` and no
dataset metadata is registered. If a window load fails, the table view displays
the error and does not claim the dataset has zero columns or rows.

## Verification

- A regression test imports a temporary CSV, queries its first bounded window,
  and verifies stable one-based row IDs plus unchanged visible column metadata.
- A project-service regression verifies an imported table can be composed for
  saving.
- Run focused Rust tests, the full Rust suite, frontend build, and the existing
  bounded-window frontend regressions.

Existing CSV tables created by the broken development build must be re-imported
after restart because their in-memory DuckDB schema has no stable row identity.