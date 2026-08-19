# Large Project Open Performance Design

## Problem

Opening a project containing a 300,000-row table blocks the desktop window and
spends minutes restoring rows. The current restore loop calls
`Connection::execute` once per row, which prepares the same INSERT statement
300,000 times. The synchronous Tauri command also prevents the window from
processing events, so Windows reports the application as not responding.

## Design

- Prepare the typed INSERT statement once per table and reuse it for every row
  inside the existing transaction.
- Keep restore staging atomic: the live project and DuckDB engine are swapped
  only after all tables restore successfully.
- Execute `open_project` as an asynchronous Tauri command so the WebView event
  loop remains responsive.
- Extend `open-project-progress` with `rowsDone` and `rowsTotal`, emitting at
  bounded intervals and at completion. The project format remains unchanged.

## Compatibility

Existing `.spprj` and `.sptb` files remain readable. Existing callers of
`restore_table_doc` continue to work without a progress callback.

## Verification

- A restore regression validates exact values and monotonic batched progress.
- Existing malformed-document rollback tests continue to pass.
- The full Rust and frontend suites pass.
- The supplied 300,000-row project is opened with elapsed time and process
  responsiveness measured.