# Graph Builder Hot Cache Design

## Problem

Graph Builder now loads large tables through bounded, cancellable windows and
reports progress, but every completed view is discarded when the user
navigates away. Returning to a Graph Builder repeats the DuckDB query, JSON
serialization, IPC transfer, WebView deserialization, and row accumulation even
when the source dataset has not changed.

ECharts also receives options without a uniform animation policy. Some custom
series disable animation, two complete options request a 250 ms animation, and
axis drag patches disable update animation only while the pointer is moving.
Unneeded initial and update tweens can consume extra frames after data and
options are already ready.

## Scope

This change adds one session-only, generation-aware, completed-data cache shared
by every Graph Builder and disables ECharts animation at the final 2D and 3D
render boundaries.

It does not persist cached rows, retain partial loads, reuse an in-flight load,
sample data, change the current row-oriented JSON IPC contract, or implement the
long-term typed columnar renderer.

## Completed-Data Cache

### Ownership

A framework-independent `GraphTableDataCache` owns at most one completed table
entry. It lives outside React component state so unmounting one Graph Builder
does not destroy the entry and another Graph Builder bound to the same dataset
can reuse the exact immutable `GraphTableData` object.

The cache is not placed in the persisted Graph Builder Zustand store. Cached
rows are transient runtime data, must not dirty the project, and must not be
serialized into graph documents.

### Entry Identity

An entry contains:

```ts
interface GraphTableDataCacheEntry {
  datasetId: string;
  generation: number;
  data: GraphTableData;
}
```

Both dataset ID and backend generation must match for a hit. Dataset ID alone
is insufficient because every successful table mutation increments generation.
Generation alone is insufficient because different datasets can have the same
generation.

The one-entry limit is deliberate. A `300,000 x 20` row-oriented JavaScript
table can retain hundreds of megabytes depending on value types and string
sizes. Retaining the most recently completed dataset supports instant switching
among all Graph Builders bound to that dataset without allowing several large
tables to accumulate in the WebView.

If the cached dataset is mutated but never opened again, its stale entry may
remain until the next cache insertion or project lifecycle clear. This does not
grow memory because the cache still owns only one entry, and the stale entry
cannot be returned after a generation mismatch.

### Load Lifecycle

Graph Builder captures the current dataset generation before loading metadata,
as it does today. It then checks the shared cache:

1. On a hit, it uses the cached data and skips all table-window requests.
2. On a miss, it runs the existing cancellable paged loader.
3. Only a fully completed result is inserted into the cache.
4. Cancellation, query failure, an empty partial response, or generation
   mismatch never commits partial data.

At load start, Graph Builder captures the cache's invalidation epoch. Insertion
uses `putIfCurrent(epoch, entry)` and succeeds only if the epoch still matches.
Every explicit clear or dataset invalidation increments the epoch. Therefore, a
late response from a component being removed cannot repopulate the cache after
a project switch, project close, new-project reset, or dataset deletion.

An empty dataset is a valid completed cache entry. The cached `GraphTableData`
object is treated as immutable after insertion.

The existing cancellation contract remains unchanged: navigating away aborts
the current Graph Builder load. A newly mounted Graph Builder does not adopt an
in-flight request and starts from page zero unless a completed cache entry
already exists.

Workspace renders at most one active Graph Builder. During rapid navigation the
old component aborts before the new component continues paging. The cache does
not add single-flight request sharing because adopting an old in-flight request
would conflict with the approved cancel-on-navigation behavior.

### Invalidation

Looking up a dataset with a different generation evicts a stale entry for that
dataset before returning a miss. In addition, the application clears the cache
when:

- a project is closed;
- a different project begins opening;
- a new empty project replaces the current project;
- the cached dataset is deleted.

Project-boundary clearing prevents an accidental hit if separate projects
contain the same dataset UUID and generation. Epoch advancement also prevents
an old asynchronous completion from reintroducing such an entry after clear.

## Animation Policy

A small pure helper applies the final animation policy to every option passed to
ECharts:

```ts
{
  ...option,
  animation: false,
  animationDuration: 0,
  animationDurationUpdate: 0,
}
```

Both `GraphPanel` and `Chart3D` use this helper immediately before their full
`setOption` calls. Applying the policy at the render boundary covers every
current and future series without duplicating flags throughout
`transform.ts`/`threeD.ts`.

The existing requestAnimationFrame-coalesced axis patch path remains intact.
It already disables animation during pointer movement; the final full option no
longer restores default animation after pointer release.

Disabling animation does not disable hover, tooltip, zoom, pan, brush, point
selection, or ResizeObserver-driven layout. It removes only interpolation
between old and new visual states. The loss of animated transitions between
series states is intentional. Interaction tests must confirm that zoom/pan and
selection still update immediately rather than depending on a transition.

## Expected Performance

A completed cache hit removes all row-window IPC and row accumulation for the
most recently used dataset. A small generation IPC and bounded metadata calls
remain so stale data is never displayed.

Disabling animation removes avoidable initial/update tween frames and should
reduce CPU/GPU peaks for medium-sized charts and animated histogram/boxplot
options. It may produce a smaller improvement for very large scatter plots
because ECharts can already suppress animation above its animation threshold.
It does not reduce JSON payload size, `buildGraph` scans, per-point object
creation, or the cost of drawing every Full Data observation.

## Error Handling

Cache operations are synchronous and cannot turn a load failure into a hit.
Errors from generation, metadata, or table queries continue to use the existing
Graph Builder error state. Cache clearing is idempotent.

## Testing

Direct tests for `GraphTableDataCache` verify:

1. exact dataset/generation hits return the same data object;
2. a different generation evicts the stale entry and misses;
3. inserting a second dataset evicts the first;
4. empty completed data is cacheable;
5. dataset invalidation and global clear are idempotent;
6. a load epoch captured before clear or invalidation cannot commit afterward.

Loader/integration tests verify:

1. a cache hit performs no table-window request;
2. a complete miss is cached;
3. cancellation, failure, and generation mismatch do not cache data;
4. project and dataset lifecycle paths clear the cache;
5. both 2D and 3D full `setOption` paths apply the shared no-animation policy.

The pure animation helper test verifies that source option fields are preserved
while all three animation fields are overridden. TypeScript checking, Vite
production build, and the existing graph/loader regressions remain required.
