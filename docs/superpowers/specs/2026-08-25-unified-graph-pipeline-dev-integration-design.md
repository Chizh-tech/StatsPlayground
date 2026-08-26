# Unified Graph Pipeline `dev` Integration Design

**Date:** 2026-08-25

**Status:** Approved

## Goal

Integrate the completed `feature/unified-graph-pipeline` work with the latest
`dev` branch and make the projection-first typed streaming pipeline the only
production Graph Builder data path.

The integration must preserve the user-visible Graph Builder behavior recently
merged into `dev` without retaining the full-table JSON loader as a fallback.

## Integration Strategy

Merge `origin/dev` into `feature/unified-graph-pipeline` in its existing
worktree, then resolve both textual and semantic conflicts on the feature
branch. This preserves the feature branch's detailed implementation history and
avoids rewriting the published branch with a force push.

The alternatives were rejected for this integration:

- Rebasing would require repeated conflict resolution across 29 published
  commits and a force push.
- Squashing onto a new branch would discard the protocol-hardening history and
  make omissions harder to detect.
- A feature flag would retain two production pipelines with different data and
  failure semantics, contrary to the unified-pipeline requirement.

## Target Architecture

Every graph uses this path:

```text
GraphDataRequest
  -> GraphDataService
  -> validated DuckDB projection and exact aggregation
  -> ordered Tauri binary chunks and aggregate packets
  -> coherent GraphDataFrame commit
  -> ECharts non-raw layers plus panel-local Canvas 2D raw points
```

`useGraphDataPipeline` replaces `loadGraphTableData` in Graph Builder. The
production Graph Builder must not load a complete table into an `unknown[][]`
or maintain the full-table hot cache as a second data source.

DuckDB projects only bound fields and fields required by filters, facets,
multi-axis roles, styling, and graph elements. Exact aggregates are computed
from all filtered rows. Raw observations are streamed as aligned typed buffers
with validity bitmaps and dictionaries.

ECharts continues to own axes, labels, aggregate series, layout, and the chart
interaction framework. A panel-local Canvas 2D layer renders raw points from
typed chunks without creating one JavaScript data object per observation.

## Request And Commit Lifecycle

1. Graph Builder constructs a `GraphDataRequest` from the active dataset,
   dataset generation, field bindings, filters, graph elements, sampling mode,
   and viewport.
2. Starting a request synchronously cancels the prior active request and assigns
   a unique request ID.
3. Rust validates dataset generation, fields, filters, identifiers, graph
   elements, and sampling parameters before executing parameterized DuckDB
   queries.
4. The backend sends raw typed chunks and exact aggregate packets under an
   ordered stream contract.
5. The frontend accepts messages only when request ID and generation match the
   current pending request. It rejects duplicate chunks, missing chunks,
   contradictory final markers, malformed payload ranges, and invalid aggregate
   packets.
6. The pending frame replaces the committed frame only after coherent
   completion. The previous complete graph remains visible during loading.
7. A valid empty result commits as an empty frame. It is not treated as an
   error or confused with an incomplete stream.

## Behavior Preservation Matrix

The integration preserves these behaviors from the latest `dev` branch:

| Behavior | Integrated rule |
| --- | --- |
| Full Data default | Full Data remains the persisted and runtime default. |
| Explicit sampling only | Raw points are sampled only after explicit user selection. Exact aggregates always use all filtered rows. |
| Visible progress | Progress uses backend `processedRows` and `sourceRows` and remains accessible to assistive technology. |
| Cancellation | Dataset changes, project lifecycle changes, request changes, and component teardown cancel active streams. |
| Stale-result guard | Both request ID and dataset generation guard every asynchronous message and final commit. |
| Axis rebinding | Changing a bound field clears `min`, `max`, and `tickInterval`; rebinding the same field preserves zoom. |
| No animation | Final 2D and 3D ECharts options retain the no-animation policy. Canvas raw points draw without staged progressive appearance. |
| Stable display | The prior coherent frame remains visible until the replacement frame commits. |
| Project compatibility | Existing graph documents remain readable; missing sampling settings default to Full Data. |

The full-table `graphTableDataCache` is not part of the integrated Graph Builder
runtime. Cache lifecycle tests that only enforce storage of complete row arrays
must be removed or rewritten as coherent-frame lifecycle tests. The utility may
remain only if another verified caller still owns it.

## Failure Semantics

- Cancellation never commits a partial frame and is not presented as a data
  error.
- Project close, project replacement, dataset deletion, and generation changes
  fence all late stream messages.
- Backend, transport, decoding, ordering, or aggregate validation failures set
  an explicit error state while preserving the previous committed frame.
- The implementation does not silently retry through the legacy JSON path.
- Full Data does not silently degrade to sampling or omit valid filtered rows.
- SQL values remain parameterized. Dynamic identifiers must be validated against
  dataset metadata and quoted by the backend's identifier helper.
- Absolute paths and backend implementation details do not cross the IPC
  boundary.

## Conflict Resolution Rules

Textual conflict resolution follows ownership rather than choosing one branch
wholesale:

- The unified branch owns the typed graph contract, stream service, frame
  reducer, aggregate packets, Canvas raw-point layer, and Graph Builder data
  source.
- Latest `dev` owns axis-binding reset semantics, final ECharts no-animation
  policy, project and dataset lifecycle behavior, current localization content,
  and unrelated Graph Builder UI changes.
- Where the short-term loader and hot cache overlap with the unified pipeline,
  retain the user behavior but implement it through stream state and coherent
  frame commits.
- Do not alter unrelated project-save, table, filter, history, or tabulate
  behavior while resolving graph conflicts.

## Validation

The integration is acceptable only after all applicable gates pass:

1. `git diff --check origin/dev...HEAD` reports no whitespace errors.
2. Typed contract, payload decoder, stream ordering, aggregate packet, Canvas
   geometry, hit-testing, and frame lifecycle regression tests pass.
3. Recent `dev` regressions for loading, axis rebinding, animation, 3D, project
   lifecycle, and save behavior pass or are deliberately rewritten when their
   old full-table-cache premise no longer exists.
4. `npm run build` succeeds.
5. `cargo test` succeeds in `src-tauri`.
6. `cargo clippy` succeeds without introducing new warnings attributable to the
   integration.
7. The 300,000-row Full Data benchmark records wall time, transferred bytes,
   and peak memory using the branch's performance harness.
8. A Tauri development build is manually checked for scatter, histogram,
   boxplot, heatmap, facets, 3D, filters, cancellation, project switching, field
   rebinding, progress, error display, and empty data.

Existing repository warnings, including the Vite large-chunk warning and known
Rust dead-code or style warnings, are reported separately and are not silently
treated as integration regressions.

## Delivery

After validation, push `feature/unified-graph-pipeline` without rewriting its
history and create a non-draft GitHub pull request targeting `dev`. The pull
request must summarize the architecture cutover, preserved behaviors,
performance evidence, automated verification, manual checks, and any residual
risks.