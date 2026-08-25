# Graph Builder Loading Progress Design

## Problem

Graph Builder now loads Full Data in bounded, cancellable windows, but its
loading state only says that data is loading. For a large table, users cannot
tell whether loading is advancing or estimate how much remains.

## Scope

Show determinate loading progress inside the existing Graph Builder canvas
placeholder while preserving the current Full Data, generation-checked, and
cancellable loading behavior. The display includes a progress bar, percentage,
and localized loaded-row count. This change does not add sampling, retain
partial data after navigation, or introduce a global blocking overlay.

## Architecture

`loadGraphTableData` accepts an optional progress callback with
`loadedRows` and `totalRows`. The loader invokes it only after a returned page
passes the abort and generation checks and its rows have been appended. This
keeps progress aligned with data that belongs to the current load and prevents
cancelled, stale, or invalid responses from advancing the UI.

`GraphBuilderView` owns the progress state. Each new load clears the previous
state before requesting metadata. The loader callback updates this state while
the view remains mounted. The existing `AbortController` cleanup prevents late
responses from updating progress after navigation.

No Rust command or IPC model changes are required because every table window
already returns `totalRows`.

## UI Behavior

The existing centered loading placeholder becomes a compact vertical loading
status containing:

1. the localized Graph Builder loading message;
2. a progress bar;
3. a percentage and localized `loadedRows / totalRows` row count.

Before the first page returns, the total is not yet known, so the progress bar
is indeterminate and the numeric detail is omitted. After the first valid page,
the bar becomes determinate. Percentage is clamped to `0..100`, and displayed
row counts use locale-aware number formatting.

The UI updates once per completed page. It does not render partial rows or a
separate completion screen: when all rows are available, Graph Builder replaces
the loading placeholder with the graph. Zero-row datasets report zero rows
without division by zero.

Cancellation remains silent. Genuine errors replace the progress display with
the existing Graph Builder error state. Re-entering Graph Builder starts a new
load with a fresh indeterminate state.

The progress bar follows the existing workspace progress-bar visual language,
with Graph Builder-local layout styles so no global modal or workspace state is
introduced.

## Localization

Add Graph Builder translations for the progress detail in English, Vietnamese,
Simplified Chinese, and Traditional Chinese. The message receives formatted
`loaded` and `total` values, while the percentage remains a numeric UI value.

## Testing

The direct loader test verifies:

1. progress is reported after each valid page with monotonically increasing
   loaded rows and the server-provided total;
2. the final progress count matches the returned Full Data row count;
3. abort after or during a response does not emit progress for discarded data;
4. a generation mismatch does not emit progress;
5. zero-row data reports a valid zero-row state.

The source integration test verifies that `GraphBuilderView` passes the progress
callback and renders the progress state. TypeScript checking and the Vite
production build validate the React, CSS, and localization integration.