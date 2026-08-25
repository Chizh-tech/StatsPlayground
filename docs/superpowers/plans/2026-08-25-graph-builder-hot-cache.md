# Graph Builder Hot Cache Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make repeat Graph Builder visits for the most recently completed dataset avoid all row-window loading, and remove unnecessary ECharts initial/update animation in 2D and 3D.

**Architecture:** Add a framework-independent one-entry cache keyed by dataset ID and generation, with an invalidation epoch that rejects late writes after project or dataset lifecycle clears. Integrate it around the existing cancellable loader without changing cancellation semantics, then apply one pure no-animation helper at both final ECharts `setOption` boundaries.

**Tech Stack:** React 19, TypeScript 5.7, Zustand 5, ECharts 6, direct Node TypeScript tests, Vite 6.

## Global Constraints

- Cache at most one fully completed row-oriented dataset in the WebView.
- Cache identity is exactly `datasetId + generation`.
- Full Data remains the default; do not add sampling or omit valid rows.
- Do not cache partial, cancelled, failed, or generation-mismatched loads.
- Preserve cancel-on-navigation; do not adopt or share in-flight requests.
- Every clear or dataset invalidation advances an epoch so a pre-clear load cannot commit afterward.
- Clear at project close, project replacement/open start, new-project reset, and cached dataset deletion.
- Cached rows remain transient and never enter persisted Zustand/project documents.
- Disable ECharts interpolation only; preserve hover, tooltip, zoom, pan, brush, selection, and resize behavior.
- Do not add Rust commands, IPC models, dependencies, persistent cache files, or push commits.

---

### Task 1: One-Entry Generation Cache

**Files:**
- Create: `src/utils/graphTableDataCache.ts`
- Create: `tests/graphTableDataCache.test.ts`

**Interfaces:**
- Consumes: `GraphTableData` from `loadGraphTableData.ts`.
- Produces: `GraphTableDataCache`, singleton `graphTableDataCache`, and methods `captureEpoch()`, `get(datasetId, generation)`, `putIfCurrent(epoch, datasetId, generation, data)`, `invalidateDataset(datasetId)`, and `clear()`.

- [ ] **Step 1: Write the failing cache tests**

Create a direct Node test that imports the missing module and verifies:

```ts
const cache = new GraphTableDataCache();
const first = { columns: ["x"], rows: [[1]] };
const epoch = cache.captureEpoch();

assert.equal(cache.putIfCurrent(epoch, "a", 1, first), true);
assert.equal(cache.get("a", 1), first);
assert.equal(cache.get("a", 2), undefined);
```

Add independent assertions for:

- inserting dataset `b` evicts dataset `a`;
- `{ columns: [], rows: [] }` is cacheable;
- `invalidateDataset("a")` is idempotent and advances epoch even if `a` is not cached;
- `clear()` is idempotent and advances epoch;
- an epoch captured before either invalidation operation cannot commit afterward;
- a generation-mismatch lookup evicts the stale entry but does not advance the epoch.

- [ ] **Step 2: Run the direct test and verify RED**

Run:

```powershell
node --experimental-strip-types tests/graphTableDataCache.test.ts
```

Expected: module-not-found failure for `graphTableDataCache.ts`.

- [ ] **Step 3: Implement the minimal cache**

Use one private optional entry and a monotonic numeric epoch:

```ts
export class GraphTableDataCache {
  private entry: GraphTableDataCacheEntry | undefined;
  private epoch = 0;

  captureEpoch(): number {
    return this.epoch;
  }

  get(datasetId: string, generation: number): GraphTableData | undefined {
    if (!this.entry) return undefined;
    if (this.entry.datasetId === datasetId && this.entry.generation === generation) {
      return this.entry.data;
    }
    if (this.entry.datasetId === datasetId) this.entry = undefined;
    return undefined;
  }

  putIfCurrent(
    epoch: number,
    datasetId: string,
    generation: number,
    data: GraphTableData,
  ): boolean {
    if (epoch !== this.epoch) return false;
    this.entry = { datasetId, generation, data };
    return true;
  }

  invalidateDataset(datasetId: string): void {
    this.epoch += 1;
    if (this.entry?.datasetId === datasetId) this.entry = undefined;
  }

  clear(): void {
    this.epoch += 1;
    this.entry = undefined;
  }
}

export const graphTableDataCache = new GraphTableDataCache();
```

- [ ] **Step 4: Run the direct test and verify GREEN**

Run:

```powershell
node --experimental-strip-types tests/graphTableDataCache.test.ts
```

Expected: `graph table data cache passed`.

- [ ] **Step 5: Commit the cache contract**

```powershell
git add src/utils/graphTableDataCache.ts tests/graphTableDataCache.test.ts
git commit -m "feat(graph): add generation-aware data cache"
```

---

### Task 2: Graph Builder And Project Lifecycle Integration

**Files:**
- Modify: `src/components/graphBuilder/loadGraphTableData.ts`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/Workspace.tsx`
- Modify: `src/stores/useProjectStore.ts`
- Modify: `tests/loadGraphTableData.test.ts`

**Interfaces:**
- Consumes: singleton `graphTableDataCache` from Task 1 and existing `loadGraphTableData` cancellation/generation behavior.
- Produces: optional `cache` and required-with-cache `cacheEpoch` loader options, completed-data hits that skip `queryTableWindow`, guarded cache commits, and explicit project/dataset lifecycle invalidation.

- [ ] **Step 1: Write failing integration assertions**

Extend the real asynchronous loader tests. Pass a fresh cache and captured epoch,
seed it with completed data, and verify a cache hit performs no query:

```ts
let requests = 0;
const result = await loadGraphTableData({
  datasetId: "cached",
  generation: 4,
  signal: new AbortController().signal,
  cache,
  cacheEpoch,
  queryWindow: async () => {
    requests += 1;
    throw new Error("cache hit must not query");
  },
});

assert.equal(result, cachedData);
assert.equal(requests, 0);
```

Add behavioral cases proving a completed miss is cached and cancellation,
query failure, and generation mismatch do not populate the cache. Add a case
that clears the cache while a page is in flight and proves the completed result
is returned to the still-mounted caller but `putIfCurrent` rejects reuse.

Retain narrow source wiring assertions that `GraphBuilderView.tsx` captures an
epoch before its first await and passes `cache: graphTableDataCache` plus
`cacheEpoch` to `loadGraphTableData`.

Read `useProjectStore.ts` and assert `graphTableDataCache.clear()` occurs before
each service call in `initProject`, `createProject`, and `openProject`. Read
`Workspace.tsx` and assert dataset deletion invalidates before backend deletion:

```ts
assert.match(workspaceSource, /graphTableDataCache\.invalidateDataset\(id\)/);
```

- [ ] **Step 2: Run the integration test and verify RED**

Run:

```powershell
node --experimental-strip-types tests/loadGraphTableData.test.ts
```

Expected: assertion failure because cache integration is absent.

**Step 3: Integrate cache lookup and guarded insertion**

Extend `LoadGraphTableDataOptions` with a structural cache port and optional
cache fields:

```ts
interface GraphTableDataCachePort {
  get(datasetId: string, generation: number): GraphTableData | undefined;
  putIfCurrent(
    epoch: number,
    datasetId: string,
    generation: number,
    data: GraphTableData,
  ): boolean;
}
```

At loader entry, return an exact cache hit before requesting a window. On normal
completion, including a valid empty dataset, call `putIfCurrent` before returning
the complete result. Do not insert on any cancellation or thrown error.

In the Graph Builder effect, capture the epoch synchronously before the first
await, then pass the singleton and epoch to the loader:

```ts
const cacheEpoch = graphTableDataCache.captureEpoch();

// after generation/metadata setup
cache: graphTableDataCache,
cacheEpoch,
```

Metadata and display properties still load for both cache hits and misses. Do
not cache in catch/finally or adopt another component's promise.

- [ ] **Step 4: Integrate lifecycle clearing**

Import the singleton into `useProjectStore.ts`. Call `clear()` synchronously at
the start of `initProject`, `createProject`, and `openProject`, before the
corresponding asynchronous service call. This covers app initialization,
new-project creation, close-to-empty reset, and every project replacement entry
point independent of UI caller. Import it into `Workspace.tsx` and call
`invalidateDataset(id)` before `dataService.deleteDataset(id)`. Repeated calls
are allowed because the operations are idempotent and epoch advancement is the
safety boundary.

- [ ] **Step 5: Run focused tests and verify GREEN**

Run:

```powershell
node --experimental-strip-types tests/graphTableDataCache.test.ts
node --experimental-strip-types tests/loadGraphTableData.test.ts
npx tsc -b
```

Expected: both tests print their pass messages and TypeScript exits `0`.

- [ ] **Step 6: Commit lifecycle integration**

```powershell
git add src/components/graphBuilder/loadGraphTableData.ts src/components/graphBuilder/GraphBuilderView.tsx src/components/Workspace.tsx src/stores/useProjectStore.ts tests/loadGraphTableData.test.ts
git commit -m "feat(graph): reuse completed table data"
```

---

### Task 3: Unified No-Animation Render Boundary

**Files:**
- Create: `src/graphCore/animation.ts`
- Create: `tests/graphAnimation.test.ts`
- Modify: `src/graphCore/Graph.tsx`
- Modify: `src/graphCore/Chart3D.tsx`

**Interfaces:**
- Consumes: ECharts option objects built by `transform.ts` and `threeD.ts`.
- Produces: `withoutGraphAnimation<T extends Record<string, unknown>>(option: T): T & GraphAnimationPolicy`, applied to all full 2D/3D `setOption` calls.

- [ ] **Step 1: Write failing helper and source integration tests**

Create a direct test that imports the missing helper and verifies source fields
are preserved while animation settings are overridden:

```ts
const source = { series: [{ type: "scatter" }], animation: true, animationDuration: 250 };
const result = withoutGraphAnimation(source);

assert.notEqual(result, source);
assert.equal(result.series, source.series);
assert.equal(result.animation, false);
assert.equal(result.animationDuration, 0);
assert.equal(result.animationDurationUpdate, 0);
```

Read `Graph.tsx` and `Chart3D.tsx` and assert each full `setOption` path calls
`withoutGraphAnimation(...)`. Keep the existing axis-patch `animation: false`
assertion because that path uses partial options rather than the helper.

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node --experimental-strip-types tests/graphAnimation.test.ts
```

Expected: module-not-found failure for `animation.ts`.

- [ ] **Step 3: Implement and apply the helper**

Create:

```ts
interface GraphAnimationPolicy {
  animation: false;
  animationDuration: 0;
  animationDurationUpdate: 0;
}

export function withoutGraphAnimation<T extends Record<string, unknown>>(
  option: T,
): T & GraphAnimationPolicy {
  return {
    ...option,
    animation: false,
    animationDuration: 0,
    animationDurationUpdate: 0,
  };
}
```

Wrap only full options passed by the option-prop effect in `GraphPanel` and by
the built-option effect in `Chart3D`. Do not change the partial axis-drag
`setOption` call or ECharts interaction handlers.

- [ ] **Step 4: Run focused and full frontend verification**

Run:

```powershell
node --experimental-strip-types tests/graphAnimation.test.ts
node --experimental-strip-types tests/graphTableDataCache.test.ts
node --experimental-strip-types tests/loadGraphTableData.test.ts
npx tsc -b
npx vite build
git diff --check
```

Expected: all direct tests print pass messages; TypeScript and Vite exit `0`;
diff check emits no errors.

- [ ] **Step 5: Commit the animation policy**

```powershell
git add src/graphCore/animation.ts tests/graphAnimation.test.ts src/graphCore/Graph.tsx src/graphCore/Chart3D.tsx
git commit -m "perf(graph): disable chart animations"
```

- [ ] **Step 6: Run final verification**

Run the three direct tests, `npx tsc -b`, `npx vite build`, and
`git diff --check` after the commit. Confirm `git status --short --branch`
contains no new tracked implementation changes and do not push.