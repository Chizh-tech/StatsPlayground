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