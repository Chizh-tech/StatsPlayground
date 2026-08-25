# Cancellable Graph Builder Loading Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep Workspace navigation responsive while a Full Data Graph Builder loads and stop requesting remaining pages as soon as the view unmounts.

**Architecture:** Extract a framework-independent paged loader that uses the existing `queryTable` service through an injected page source. It requests a fixed row count, yields to the browser event loop between pages, and checks an `AbortSignal` at every async boundary. `GraphBuilderView` owns the controller and only commits complete data from a non-aborted load.

**Tech Stack:** React 19, TypeScript 5.7, Tauri IPC, Node direct TypeScript tests, Vite 6.

## Global Constraints

- Full Data remains the default; do not sample or truncate rows.
- Every row count uses the same bounded paging path.
- Navigation away cancels all remaining pages and discards accumulated rows.
- Cancellation is silent; real query failures remain visible.
- Do not modify Rust commands or project archive formats.
- Do not include unrelated `src-tauri/Cargo.toml` or generated schema worktree changes.

---

### Task 1: Cancellable Paged Loader

**Files:**
- Create: `src/components/graphBuilder/loadGraphTableData.ts`
- Create: `tests/loadGraphTableData.test.ts`

**Interfaces:**
- Produces: `GRAPH_TABLE_PAGE_SIZE = 4096`
- Produces: `loadGraphTableData(options: LoadGraphTableDataOptions): Promise<GraphTableData | null>`
- `LoadGraphTableDataOptions` contains `datasetId`, `signal`, `queryPage`, and optional `yieldToBrowser` for deterministic tests.
- `queryPage(datasetId, page, pageSize)` returns `{ columns: string[]; rows: unknown[][]; totalRows: number }`.
- `null` means cancellation; thrown errors mean genuine load failure.

- [ ] **Step 1: Write the failing loader tests**

Create a direct Node test that imports the loader by relative path and asserts:

```ts
const result = await loadGraphTableData({
  datasetId: "large",
  signal: new AbortController().signal,
  queryPage: async (_datasetId, page) => pages[page],
  yieldToBrowser: async () => { events.push("yield"); },
});
assert.deepEqual(result?.rows, [[1], [2], [3]]);
assert.deepEqual(events, ["page-0", "yield", "page-1"]);
```

Add separate cases that abort during the first response and during the yield. Assert both resolve `null` and never request page 1. Add a rejected page and assert the same error propagates.

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
node --experimental-strip-types tests/loadGraphTableData.test.ts
```

Expected: FAIL because `loadGraphTableData.ts` does not exist.

- [ ] **Step 3: Implement the minimal loader**

Implement the loop with these exact rules:

```ts
export const GRAPH_TABLE_PAGE_SIZE = 4096;

export async function loadGraphTableData(options: LoadGraphTableDataOptions): Promise<GraphTableData | null> {
  const rows: unknown[][] = [];
  let columns: string[] = [];
  for (let page = 0; ; page += 1) {
    if (options.signal.aborted) return null;
    const result = await options.queryPage(options.datasetId, page, GRAPH_TABLE_PAGE_SIZE);
    if (options.signal.aborted) return null;
    if (page === 0) columns = result.columns;
    rows.push(...result.rows);
    if (rows.length >= result.totalRows || result.rows.length === 0) {
      return { columns, rows };
    }
    await (options.yieldToBrowser ?? yieldToBrowser)();
    if (options.signal.aborted) return null;
  }
}
```

The production yield uses `setTimeout(resolve, 0)` so rendering and click events can run before the next IPC call.

- [ ] **Step 4: Run loader tests and typecheck**

Run:

```powershell
node --experimental-strip-types tests/loadGraphTableData.test.ts
npx tsc -b
```

Expected: all loader cases pass and TypeScript exits 0.

- [ ] **Step 5: Commit Task 1**

```powershell
git add src/components/graphBuilder/loadGraphTableData.ts tests/loadGraphTableData.test.ts
git commit -m "feat(graph): add cancellable paged data loader"
```

### Task 2: Graph Builder Integration

**Files:**
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `tests/loadGraphTableData.test.ts`

**Interfaces:**
- Consumes: `loadGraphTableData` and `GRAPH_TABLE_PAGE_SIZE` from Task 1.
- Uses existing `dataService.queryTable({ datasetId, page, pageSize })` as `queryPage`.
- The effect cleanup calls `controller.abort()`.

- [ ] **Step 1: Add failing integration source assertions**

Extend the direct test to read `GraphBuilderView.tsx` and assert the load effect:

```ts
assert.match(source, /const controller = new AbortController\(\)/);
assert.match(source, /loadGraphTableData\(\{/);
assert.match(source, /signal: controller\.signal/);
assert.match(source, /return \(\) => \{\s*controller\.abort\(\)/);
assert.doesNotMatch(source, /pageSize: Math\.max\(1, dataset\.rowCount/);
```

- [ ] **Step 2: Run the test to verify RED**

Run:

```powershell
node --experimental-strip-types tests/loadGraphTableData.test.ts
```

Expected: FAIL because GraphBuilder still performs one row-count-sized query.

- [ ] **Step 3: Integrate the loader**

In the Graph Builder load effect:

1. Create one `AbortController` before starting async work.
2. Load columns and display properties without changing their behavior.
3. Call `loadGraphTableData` with a `queryPage` adapter around `dataService.queryTable`.
4. If the result is `null` or the signal is aborted, return without state updates.
5. Build value-order/spec maps and commit fields/data only after the full paged load completes.
6. In cleanup, call `controller.abort()`.
7. Do not report cancellation through `setError` or clear loading after unmount.

- [ ] **Step 4: Run focused verification**

Run:

```powershell
node --experimental-strip-types tests/loadGraphTableData.test.ts
npx tsc -b
npx vite build
```

Expected: loader/integration tests pass, typecheck exits 0, Vite build succeeds.

- [ ] **Step 5: Manual cancellation check**

Start the feature worktree app with `cargo tauri dev`. Open a Graph Builder backed by a large dataset and immediately click a table or another workspace item. Verify the destination view becomes active before the Graph Builder finishes loading and no stale Graph Builder appears afterward. Re-enter the Graph Builder and verify it starts a fresh Full Data load.

- [ ] **Step 6: Commit Task 2**

```powershell
git add src/components/graphBuilder/GraphBuilderView.tsx tests/loadGraphTableData.test.ts
git commit -m "fix(graph): keep navigation responsive during data load"
```

### Task 3: Final Review and Verification

**Files:**
- Review only the files changed by Tasks 1-2.

- [ ] **Step 1: Run final checks**

```powershell
node --experimental-strip-types tests/loadGraphTableData.test.ts
node --experimental-strip-types tests/saveReadOnly.test.ts
npx tsc -b
npx vite build
cargo test --manifest-path src-tauri/Cargo.toml --features perf-harness
```

Expected: all direct tests pass, frontend builds, and Rust remains green.

- [ ] **Step 2: Review cancellation and Full Data invariants**

Confirm that each page is bounded at 4096 rows, all pages concatenate in order, cancellation cannot request another page, no partial data is committed, real errors propagate, and no unrelated worktree files are staged.

- [ ] **Step 3: Push only when explicitly requested**

Do not push automatically. Preserve the feature worktree and unrelated pending files.
