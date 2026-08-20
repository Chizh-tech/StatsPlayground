# Task 5 Report - Unified Panel-Local Raw Points Layer

Date: 2026-08-20
Base: 4b8052ec205768eae95f55a938e54511815c7929

## TDD RED -> GREEN

- RED step:
  - Added `tests/rawPoints.test.ts` first.
  - Ran `node --experimental-strip-types tests/rawPoints.test.ts`.
  - Observed expected failure: module not found for `src/graphCore/rawPoints.ts`.
- GREEN step:
  - Implemented `src/graphCore/rawPoints.ts` pure typed-buffer geometry/index/hit helpers.
  - Updated digest fixture and deterministic brush ordering.
  - Re-ran `node --experimental-strip-types tests/rawPoints.test.ts` -> pass.

## Deterministic RGBA Digest

- Raster size: 64x64
- Fixture points: 10
- Digest helper: `stableRgbaDigest` (pure in-memory FNV-1a 64-bit)
- Locked digest: `1a49a1b6852baea5`

## Interaction and Layer Decisions

- Panel-local canvas:
  - Added one `RawPointsLayer` canvas per `GraphPanel`.
  - Canvas is absolutely positioned in panel body with `pointer-events: none` so axis gestures and ECharts pointer routing are preserved.
- Transform/clip sharing:
  - Numeric projector is derived from ECharts `convertFromPixel` samples (affine scale/offset).
  - Categorical projector is derived from ECharts `convertToPixel` category positions.
  - Draw clipping uses panel grid rect and excludes out-of-clip points from draw/index.
- Redraw lifecycle:
  - Redraw is scheduled via RAF.
  - Repaint triggers on ECharts `rendered` and panel resize observer.
- Click/brush routing:
  - Raw point click now checks pixel index first (`hitTestPoint`) using event pixel offsets.
  - Brush uses pixel index first (`hitTestBrush`) when available; falls back to legacy ECharts scatter scan otherwise.
  - Aggregate/synthetic ECharts behavior remains available through legacy path.
- Overpaint/index semantics:
  - Every valid row is processed (no sampling).
  - Same-pixel overlap keeps full offset stack; topmost is deterministic (last drawn).
  - Brush result order is deterministic by compact source offset order.
- Jitter:
  - Default is `none`.
  - Optional deterministic seeded jitter (`rawPointJitter = seeded`) via explicit seed/amplitude options.

## Descriptor Plumbing / Cutover Behavior

- Extended `buildGraph(...)` to accept optional `GraphDataFrame`.
- Added optional panel `rawPoints` descriptor in `BuiltGraph.panels`.
- Descriptor creation is typed-buffer-only (from `GraphDataFrame.rawChunks`), no row-object fallback.
- For faceted/wrap panels, descriptors are intentionally `null` for now pending facet-local packet masks in Task 6+.
- Existing production behavior remains preserved when no frame-backed descriptor is provided.

## Files Changed

- `src/graphCore/rawPoints.ts` (new)
- `src/graphCore/RawPointsLayer.tsx` (new)
- `tests/rawPoints.test.ts` (new)
- `src/graphCore/Graph.tsx`
- `src/graphCore/transform.ts`
- `src/graphCore/types.ts`
- `src/graphCore/index.ts`

## Validation

- `node --experimental-strip-types tests/rawPoints.test.ts` -> pass
- `node --experimental-strip-types tests/graphDataPipeline.test.ts` -> pass
- `npx vite build` -> pass

## Concerns / Follow-ups

- `ScatterPointPick.rowId` remains `number`; frame-backed `i64` row IDs are converted to `number` for existing callback contracts. Very large row IDs (> `Number.MAX_SAFE_INTEGER`) are skipped in raw click/brush conversion.
- Facet-local typed chunk masking is deferred until aggregate packet metadata can identify panel membership (Task 6/7 cutover path).

## Fix Round 1 (Task 5)

### Scope

- Fixed raw/ECharts interleaving to support: base chart geometry below raw pixels, raw points in the middle, and reference/interaction carriers above raw points.
- Factored bigint row-id conversion into pure helpers and added explicit safe-range tests.
- Factored DPR backing-store math + transform reset into pure helpers and wired panel canvas redraw to keep geometry/hit index in CSS pixels.

### RED Evidence (TDD)

- After adding focused tests first, running:
  - `node --experimental-strip-types tests/rawPoints.test.ts`
- Failed as expected with:
  - `ERR_MODULE_NOT_FOUND: ../src/graphCore/layers.ts`

### DOM/ZLevel Investigation Evidence

- Local zrender source confirms zlevel-based layer model and default zlevel behavior:
  - `node_modules/zrender/dist/zrender.js:2766` (`return a.zlevel - b.zlevel;`)
  - `node_modules/zrender/dist/zrender.js:2855` (`disp.zlevel = 0;`)
- Graph host remains absolute without its own z-index:
  - `src/graphCore/Graph.tsx:1080` (`<div ref={chartHostRef} style={{ position: "absolute", inset: 0 }} />`)
- Raw canvas is sibling absolute layer with pointer passthrough:
  - `src/graphCore/RawPointsLayer.tsx:177` (`pointerEvents: "none"`)
  - `src/graphCore/RawPointsLayer.tsx:178` (`zIndex: GRAPH_RAW_CANVAS_Z_INDEX`)

### Mechanism Implemented

- New layer constants and policy in `src/graphCore/layers.ts`:
  - `GRAPH_SERIES_BASE_ZLEVEL = 0`
  - `GRAPH_RAW_CANVAS_Z_INDEX = 5`
  - `GRAPH_SERIES_OVERLAY_ZLEVEL = 10`
- Series-level policy via `withInterleavedGraphLayers(...)`:
  - Base series default to zlevel 0.
  - Reference/interaction carriers are promoted to zlevel >= 10:
    - ids `__ref_lines_*`, `__band_ref_lines_*`, `*__fitstats`, or series carrying `markLine`.
- Runtime zrender DOM synchronization via `applyZrenderCanvasZIndices(...)`:
  - Reads zrender painter `_layers` map and writes each layer canvas `style.zIndex = zlevel`.
  - Called after `setOption` and on zrender `rendered`.
  - This ensures chart-host canvases and raw canvas share one stacking context and can interleave by z-index.

### Row ID Policy Fix

- Added pure helpers in `src/graphCore/rawPoints.ts`:
  - `bigintToSafeNumber(...)`
  - `bigintToScatterPointPick(...)`
- Graph click path now uses shared helper in `src/graphCore/Graph.tsx`.
- Policy preserved: out-of-safe-range and negative row IDs are skipped; public pick contract remains `number`.

### DPR Fix

- Added pure helpers in `src/graphCore/rawPoints.ts`:
  - `computeCanvasBackingStore(...)`
  - `resetAndScaleCanvasContext(...)`
- `RawPointsLayer` now:
  - Sets backing store to `CSS * devicePixelRatio`.
  - Keeps CSS width/height unchanged.
  - Resets transform before clear/scale each redraw to avoid cumulative scaling.
  - Keeps draw geometry + pixel index in CSS-pixel coordinates.

### New Focused Contract Tests

- `tests/rawPoints.test.ts` now covers:
  - Safe-range bigint conversion (min/max safe bounds) and out-of-range rejection.
  - `bigint -> ScatterPointPick` conversion policy (negative/out-of-range rejected).
  - DPR 1 and 2 backing-store dimensions.
  - Transform reset ordering (`setTransform(1) -> clearRect -> setTransform(scale)`).
  - Interleaved layer contract (`base < raw < overlay`) and zrender layer z-index synchronization.

### GREEN Verification

- `node --experimental-strip-types tests/rawPoints.test.ts` -> pass
- `node --experimental-strip-types tests/graphDataPipeline.test.ts` -> pass
- `npx vite build` -> pass (`built in 8.66s`)

## Fix Round 2 (Task 5)

### Open Findings Addressed

- CRITICAL: Replaced brush-path raw pick conversion in `Graph.tsx` with the shared tested helper `bigintToScatterPointPick(...)`.
- CRITICAL: Added a source-guard test asserting `Graph.tsx` contains no `toScatterPick(` call and uses `bigintToScatterPointPick(` in both click and brush paths.
- IMPORTANT: Generalized overlay classifier to promote any series with visible labels (`label`, `endLabel`, `upperLabel`) and current nested state labels (`emphasis`, `select`, `blur`) to overlay zlevel.
- IMPORTANT: Added focused layer-classification tests for representative base bar, label-show series, ref carrier, markLine carrier, and fitstats carrier.

### RED Evidence (TDD)

- After adding tests first:
  - `node --experimental-strip-types tests/rawPoints.test.ts` failed with overlay zlevel assertion (`0 !== 10`) for label-visible series.
  - `node --experimental-strip-types tests/graphDataPipeline.test.ts` failed with `Graph.tsx must not call undefined toScatterPick`.

### GREEN Verification

- `node --experimental-strip-types tests/rawPoints.test.ts` -> pass
- `node --experimental-strip-types tests/graphDataPipeline.test.ts` -> pass
- `npx vite build` -> pass (`vite v6.4.1`, `970 modules transformed`, built in `12.18s`)

### `_layers` Isolation / Upgrade Risk

- Kept private zrender `_layers` access isolated to the existing boundary (`applyZrenderCanvasZIndices(...)` call sites in `Graph.tsx`).
- No architecture change was introduced in this round.
- Upgrade risk note: `_layers` remains a private implementation detail in zrender and may break on upstream internals changes; if that happens, fallback should be to series-only `zlevel` ordering and disable DOM z-index sync until adapted.