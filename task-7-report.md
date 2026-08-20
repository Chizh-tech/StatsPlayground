# Task 7 Report - Cut GraphBuilderView Over To Unified Pipeline

Date: 2026-08-20
Branch: feature/unified-graph-pipeline
Base: 1ff77128847ae0173506ed3fad080ba41c4c2f34

## RED -> GREEN

RED (expected)
- Added source guard in `tests/graphDataPipeline.test.ts` to forbid GraphBuilder production-path usage of:
  - `dataService.queryTable(`
  - `applyFilters(data`
  - `newRows.push([...row`
- Ran:
  - `node --experimental-strip-types tests/graphDataPipeline.test.ts`
- Result: failed on `dataService.queryTable` (expected initial failure).

GREEN
- Reworked `GraphBuilderView` to use `useGraphDataPipeline` committed frame as the production graph source.
- Removed legacy full-table query/filter/melt production path from `GraphBuilderView`.
- Added explicit Full/Sample controls with persisted sampling state (`item.sampling`) and valid size/seed clamping.
- Added source/processed row status text:
  - Full mode: `Full Data: {{processed}} rows`
  - Sample mode: `Sampled: {{processed}} / {{source}} rows`
- Added localized pipeline/sampling/status strings in all four locales.
- Kept previous committed frame visible while pipeline status is pending/error; on error, overlay message is shown without blanking chart.

## Cutover Details

### Production path now
- Graph data comes from `useGraphDataPipeline(item, dataset, viewport)`.
- `Graph` receives:
  - `data`: bounded GraphData shell (column metadata + empty rows)
  - `frame`: committed streamed frame
- No GraphBuilder production path use of:
  - `dataService.queryTable`
  - frontend `applyFilters(data, ...)`
  - JS melt row expansion (`newRows.push([...row, ...])`

### Sampling
- Default behavior: Full mode (`{ mode: "full" }`).
- Explicit Sample mode via toolbar with persisted values:
  - size: integer >= 1
  - seed: integer >= 0
- Switching modes updates `item.sampling` and marks project dirty.

### Metadata boundary
- Column display metadata retrieval remains bounded/separate from graph row production:
  - `getColumns`
  - `getColumnDisplayProps`
- Graph row production no longer depends on frontend full-table materialization.

## Verification

Executed commands and results:

1. `node --experimental-strip-types tests/graphDataPipeline.test.ts`
- PASS (`graph-data fixture + decoder passed`)

2. `node --experimental-strip-types tests/rawPoints.test.ts`
- PASS (no output, exit 0)

3. `node --experimental-strip-types tests/transformAggregatePackets.test.ts`
- PASS (no output, exit 0)

4. `npx vite build`
- PASS

5. `cargo test --manifest-path src-tauri/Cargo.toml`
- PASS (136 passed, 0 failed)

## Compatibility Notes

- Existing GraphBuilder interactions (axis gestures, click/brush, facet slots, 3D bindings, hidden groups) remain wired through `Graph` and spec/state plumbing.
- Legacy helpers and fallback-capable transform paths are not globally removed in this task; production GraphBuilder path no longer relies on legacy full-table path.
- `dataService.queryTable` is preserved for non-graph consumers.

## Files Changed

- `tests/graphDataPipeline.test.ts`
- `src/components/graphBuilder/GraphBuilderView.tsx`
- `src/components/graphBuilder/graphBuilder.css`
- `src/i18n/locales/en.json`
- `src/i18n/locales/vi.json`
- `src/i18n/locales/zh-CN.json`
- `src/i18n/locales/zh-TW.json`
