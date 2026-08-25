# Cancellable Graph Builder Loading Design

## Problem

Opening a Graph Builder currently calls `queryTable` once with `pageSize` equal
to the dataset row count. Large JSON results monopolize DuckDB query/IPC and
WebView deserialization long enough that workspace navigation feels frozen.
The component cleanup flag prevents stale React state updates, but it cannot
make one monolithic response yield to user input.

## Scope

This change keeps Full Data as the default and uses one bounded loading path for
every row count. It addresses accidental Graph Builder selection by making
navigation responsive and stopping all remaining work when the view unmounts.
It does not add sampling, retain partial data after navigation, or implement the
separate typed-binary graph pipeline planned in
`2026-08-20-unified-graph-data-pipeline.md`.

## Architecture

Graph Builder loads metadata and table rows through a small loader module.
Rows are requested from the existing `dataService.queryTable` API in fixed,
bounded pages. After each page, the loader yields to the browser event loop
before requesting the next page, allowing workspace click handlers and React
unmount cleanup to run.

Each load owns an `AbortSignal`. Unmount aborts the signal. The loader checks it
before a request, after every response, and after every event-loop yield. An
abort discards accumulated rows and resolves as cancellation rather than an
error. A response that was already in flight may finish in the backend, but it
cannot trigger another page or update an unmounted Graph Builder.

The page size is constant for all datasets. Small tables therefore use the same
pipeline and usually finish in one page; large tables never create one
row-count-sized IPC response.

## UI Behavior

- Opening a Graph Builder immediately renders its normal local loading state.
- Workspace navigation remains enabled while pages load.
- Clicking another table, Graph Builder, Tabulate, or command unmounts the view,
  aborts the loader, and prevents all subsequent pages.
- Returning to the Graph Builder starts a fresh Full Data load from page zero.
- Genuine query failures remain visible in the Graph Builder error state;
  cancellation is silent.
- No global blocking overlay is introduced.

## Boundaries

- `src/components/graphBuilder/loadGraphTableData.ts` owns paging, yielding,
  cancellation checks, and row accumulation.
- `GraphBuilderView.tsx` owns the `AbortController`, metadata/display-property
  loading, and React state updates.
- Existing Rust commands and archive formats remain unchanged.

## Testing

A direct Node test exercises the loader with a real asynchronous fake page
source and verifies:

1. all pages concatenate in order for a normal Full Data load;
2. abort after the first page prevents requesting a second page;
3. abort while one page is in flight discards its late response;
4. the loader yields between pages so an independently queued navigation task
   runs before the next request;
5. query failures propagate while aborts do not become UI errors.

Frontend type checking and the Vite production build verify integration.
