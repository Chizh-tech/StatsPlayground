# Task 4 Report: Build One Frontend Request And Frame Lifecycle

## RED/GREEN TDD

- RED observed first:
  - Command: `node --experimental-strip-types tests/graphDataPipeline.test.ts`
  - Result: `ERR_MODULE_NOT_FOUND` for `src/components/graphBuilder/useGraphDataPipeline.ts`
  - Meaning: reducer/hook symbols did not exist before implementation.
- GREEN after implementation:
  - Command: `node --experimental-strip-types tests/graphDataPipeline.test.ts`
  - Result: `graph-data fixture + decoder passed`

## Files Changed

- Created `src/services/graphDataService.ts`
- Created `src/components/graphBuilder/useGraphDataPipeline.ts`
- Modified `src/types/graphBuilder.ts`
- Modified `src/stores/useGraphBuilderStore.ts`
- Modified `src/services/index.ts`
- Modified `tests/graphDataPipeline.test.ts`

## What Was Implemented

### 1. Service channel lifecycle (`graphDataService.stream`)

- Uses `Channel<unknown>` with `invoke("stream_graph_data", { request, onChunk: channel })`.
- Calls `invoke("cancel_graph_data", { requestId })` in explicit cancel and malformed-stream cleanup.
- Accepts ordered header/payload events from the channel, with strict validation:
  - Rejects payload before header.
  - Rejects header while a prior header is still awaiting payload.
  - Rejects duplicate chunk indices.
  - Rejects unknown message shapes.
  - Decodes payload with `decodeGraphPayload(header, payload)` (typed views over `ArrayBuffer`; no payload copy).

### 2. Pure reducer + frame lifecycle (`reduceGraphStream`)

- Added a pure, test-importable reducer in non-TSX module `useGraphDataPipeline.ts`.
- Reducer state tracks:
  - `committed` frame
  - request-scoped `pending` frame assembly
  - `pendingHeader` pairing state
  - `error` + `status`
- Guard rules:
  - Request ID + generation gates header/chunk/complete/error messages.
  - Stale messages are ignored and do not mutate active pending/committed frame.
- Error/cancel behavior:
  - Matching request error clears only pending state and keeps previous committed frame.
  - Matching request cancellation (completion.cancelled) clears only pending state and keeps previous committed frame.
- Atomic commit:
  - Pending -> committed swap only happens on coherent completion:
    - final chunk seen
    - contiguous chunk index coverage `0..finalChunkIndex`
    - `chunksSent === finalChunkIndex + 1`
    - no dangling pending header

### 3. Hook + request derivation (`useGraphDataPipeline`)

- Added `useGraphDataPipeline(item, dataset, viewport)` with dynamic service imports.
- Reads dataset generation before dispatch/start.
- Builds one request from active graph configuration:
  - Encoding roles (`x`, `y`, `z`, overlay/group facets, size, etc.)
  - Elements
  - Hidden-groups context (`group` role when needed)
  - Filters
  - Multi-axis lists (`multiX`, `multiY`)
- Sends only derived columns, not all table columns.
- Debounces viewport only (`width`/`height`), not field/filter changes.
- Hook dispatches stream outcomes through reducer with requestId+generation guards.

### 4. Persisted sampling defaults

- Added optional `sampling` to `GraphBuilderItem` type.
- Store normalization (`useGraphBuilderStore`) now enforces one explicit shape:
  - `{ mode: "full" }`, or
  - `{ mode: "sample", size, seed }` with sanitized integer values.
- Missing/invalid persisted sampling normalizes to `{ mode: "full" }`.

## Stale/Cancel Evidence

From reducer tests in `tests/graphDataPipeline.test.ts`:

- Stale headers (wrong requestId or generation) are ignored.
- Stale errors do not clear current pending.
- Matching error clears pending and preserves committed frame.
- Matching cancellation clears pending and preserves committed frame.
- Duplicate chunk index transitions to error and preserves committed frame.
- Commit stays atomic: committed frame is unchanged until coherent completion arrives.

## Verification Run

- `node --experimental-strip-types tests/graphDataPipeline.test.ts` -> pass
- `npx vite build` -> pass

## Self-Review Notes / Concerns

- `useGraphDataPipeline` is intentionally not wired into `GraphBuilderView` yet (per task requirement: no cutover).
- The reducer currently computes extents for `x`, `y`, and optional `size`; additional aggregate packet lifecycle is deferred to later tasks.
- Service currently enforces `ArrayBuffer` payload shape strictly; non-ArrayBuffer binary forms are treated as malformed.

## Fix Round 1

### Scope

- Addressed all round-1 findings for Task 4 in frontend service/hook/reducer/tests only.
- Kept GraphBuilderView and renderer wiring unchanged.

### RED Evidence

- Command: `node --experimental-strip-types tests/graphDataPipeline.test.ts`
- Initial failure after adding stricter ordering assertions:
  - `AssertionError [ERR_ASSERTION] ... Input: 'graph header chunk index 0 arrived out of order (expected 1)'`
  - This validated that strict next-index enforcement changed behavior and tests needed to be updated to the new contract.

### GREEN Evidence

- Command: `node --experimental-strip-types tests/graphDataPipeline.test.ts`
  - Result: `graph-data fixture + decoder passed`
- Command: `npx vite build`
  - Result: success (`✓ built in 7.71s`)

### Findings Closed

1. Completion race around invoke resolution
- Implemented completion sequencing with one reducer-authoritative commit path:
  - `reduceGraphStream` now stores matching completion as `pendingCompletion`.
  - Completion no longer errors immediately when pending payload is still in flight.
  - Final commit occurs only when completion + chunk coherence are both true.
- Added deterministic reducer test that simulates:
  - invoke-complete-equivalent event arriving before final payload
  - final payload arriving afterward
  - expected outcome: final frame commits correctly.

2. Hidden groups + color grouping fallback
- Request field derivation now maps hidden-group grouping through one backend-recognized `group` role.
- Fallback order now covers:
  - `overlay` -> `color` -> `groupX` -> `groupY` -> `groupZ` (3D) -> `wrap`.
- Added focused tests for color and each fallback path.
- Avoided duplicate/conflicting grouping roles by deriving a single `group` binding.

3. Only-required fields from active semantics
- Reworked `deriveFields` to include only active roles:
  - Always active: `x`, `y`
  - 3D-only when relevant element is enabled: `z`
  - Size only for size-using enabled elements (`points`, `scatter3d`)
  - Group only via active grouping semantics (or when hidden groups are present)
  - Filters always included
- Added tests proving stale unused bindings are not projected while required ones still are.

4. Strict chunk order
- Enforced exact next chunk index in reducer header handling.
- Enforced exact next chunk index in service transport header handling.
- Added out-of-order test at reducer boundary and updated strict-order expectation in duplicate-index scenario.

5. One authoritative frame reducer
- Service transport no longer performs decode/commit semantics.
- Service now only:
  - validates header shape
  - enforces transport order
  - pairs header with payload and forwards both
  - dispatches completion only when transport pairing preconditions are satisfied
- Reducer remains the sole owner of frame commit/error semantics.

### Files Updated In Round 1

- `src/components/graphBuilder/useGraphDataPipeline.ts`
- `src/services/graphDataService.ts`
- `tests/graphDataPipeline.test.ts`

## Fix Round 2

### Scope

- Closed both open round-2 findings in `feature/unified-graph-pipeline`:
  - Required-field completeness for active multi-axis bindings (`multiX`, `multiY`) while preserving stale-inactive behavior.
  - Transport-complete sequencing using an ordered terminal marker on the same Tauri channel as header/raw payload messages.
- Kept `GraphDataFrame` + `reduceGraphStream` as the only frame lifecycle authority; no second state machine was introduced.

### RED Evidence

- Command: `node --experimental-strip-types tests/graphDataPipeline.test.ts`
  - Initial result (before transport implementation):
    - `Error [ERR_MODULE_NOT_FOUND]: Cannot find module ... src/services/graphDataTransport.ts`
  - After transport skeleton creation, targeted failing assertion:
    - `AssertionError [ERR_ASSERTION] ... actual 'graph terminal marker does not match invoke completion' expected null`
  - Meaning: new round-2 protocol/multi-axis tests were active and caught the intended behavior gaps.

### GREEN Evidence

- Command: `node --experimental-strip-types tests/graphDataPipeline.test.ts`
  - Result: `graph-data fixture + decoder passed`

### Findings Closed

1. Required field completeness (`multiX`, `multiY`, facet/group)
- `deriveFields` now appends active multi-axis columns when and only when multi-mode is active (`length >= 2`).
- Added stable per-index roles that do not collide with primary `x`/`y` roles:
  - `multiX0`, `multiX1`, ...
  - `multiY0`, `multiY1`, ...
- Preserved stale-inactive behavior:
  - single-entry `multiX` / `multiY` lists are ignored as inactive stale state.
- Added focused tests covering:
  - active `multiX` inclusion,
  - active `multiY` inclusion,
  - stale inactive omission,
  - hidden-group facet fallback (`wrap` -> `group`).

2. Terminal marker protocol and indefinite-pending fix
- Added channel-transport parser module `src/services/graphDataTransport.ts` that enforces ordered transport semantics.
- Backend now emits explicit same-channel terminal completion marker after all chunk payload messages:
  - Header messages: JSON with `messageType: "header"` + `GraphChunkHeader` fields.
  - Completion messages: JSON with `messageType: "complete"` + `GraphDataCompletion` fields.
- Frontend service completion dispatch is now channel-terminal driven:
  - invoke resolution alone no longer calls `onComplete`.
  - invoke rejection still emits error.
  - terminal marker mismatch/pending-header/inconsistent `chunksSent` emits transport error and clears pending via reducer error path.
- Reducer completion handling updated to strict terminal behavior:
  - completion with pending header -> error,
  - completion with inconsistent chunk coherence -> error,
  - completion with coherent chunks -> atomic pending->committed swap.
- Added deterministic transport/reducer tests for:
  - invoke resolves before final channel event (must not complete early),
  - incomplete terminal rejection,
  - ordered `header` -> `payload` -> `complete`,
  - terminal arriving with pending header (error),
  - inconsistent `chunksSent` (error).

3. Backend ordering proof tests
- Updated/expanded Rust sink tests in `graph_data_service.rs`:
  - `stream_with_sink_orders_header_payload_then_terminal`
  - `stream_with_sink_respects_pre_start_cancellation` now expects terminal completion marker emission.

### Files Added/Updated In Round 2

- Added `src/services/graphDataTransport.ts`
- Updated `src/services/graphDataService.ts`
- Updated `src/components/graphBuilder/useGraphDataPipeline.ts`
- Updated `src-tauri/src/services/graph_data_service.rs`
- Updated `tests/graphDataPipeline.test.ts`

### Verification Run (Round 2)

- `node --experimental-strip-types tests/graphDataPipeline.test.ts` -> pass (`graph-data fixture + decoder passed`)
- `cargo test --manifest-path src-tauri/Cargo.toml services::graph_data_service::tests -- --nocapture` -> pass (`9 passed; 0 failed`)
- `cargo test --manifest-path src-tauri/Cargo.toml commands::graph_data_commands::tests -- --nocapture` -> pass (`1 passed; 0 failed`)
- `cargo check --manifest-path src-tauri/Cargo.toml` -> pass (`Finished 'dev' profile ... in 3.39s`)
- `npx vite build` -> pass (`✓ built in 13.72s`)

### Cleanup

- Restored generated schema artifacts to avoid unrelated diffs:
  - `src-tauri/gen/schemas/desktop-schema.json`
  - `src-tauri/gen/schemas/windows-schema.json`
