# Graph Builder Loading Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a determinate progress bar, percentage, and localized row counts while Graph Builder loads Full Data in cancellable windows.

**Architecture:** Extend the framework-independent table loader with an optional progress callback emitted only after a valid page is accepted. Keep React state and presentation local to `GraphBuilderView`, reusing the workspace progress-bar visual language and existing cancellation boundary without changing Rust or IPC models.

**Tech Stack:** React 19, TypeScript 5.7, direct Node TypeScript tests, CSS, i18next, Vite 6.

## Global Constraints

- Full Data remains the default for every row count; do not add sampling.
- Progress advances only after abort and generation checks pass and rows are appended.
- Cancellation is silent and late responses cannot update progress.
- Before the first valid page, show indeterminate progress without numeric detail.
- Do not add Rust commands, IPC models, dependencies, or global blocking UI.
- Preserve unrelated working-tree changes and do not push commits.

---

### Task 1: Loader Progress Contract

**Files:**
- Modify: `tests/loadGraphTableData.test.ts`
- Modify: `src/components/graphBuilder/loadGraphTableData.ts`

**Interfaces:**
- Consumes: existing `GraphTablePage` and `loadGraphTableData(options)` paging behavior.
- Produces: exported `GraphTableLoadProgress` with `loadedRows: number` and `totalRows: number`; optional `onProgress(progress: GraphTableLoadProgress): void` in loader options.

- [ ] **Step 1: Write failing progress tests**

Add assertions to the direct loader test that collect progress values from a normal two-page load:

```ts
const progress: GraphTableLoadProgress[] = [];

const result = await loadGraphTableData({
  datasetId: "large",
  generation: 7,
  signal: new AbortController().signal,
  queryWindow,
  onProgress: (next) => progress.push(next),
  yieldToBrowser,
});

assert.deepEqual(progress, [
  { loadedRows: 2, totalRows: 3 },
  { loadedRows: 3, totalRows: 3 },
]);
```

Add focused cases asserting no callback after abort following a response, no callback on generation mismatch, and `{ loadedRows: 0, totalRows: 0 }` for a valid empty page.

- [ ] **Step 2: Run the direct test and verify RED**

Run:

```powershell
node --experimental-strip-types tests/loadGraphTableData.test.ts
```

Expected: TypeScript/runtime failure because `GraphTableLoadProgress` and `onProgress` do not exist.

- [ ] **Step 3: Implement the minimal loader callback**

Add the public type and option:

```ts
export interface GraphTableLoadProgress {
  loadedRows: number;
  totalRows: number;
}

interface LoadGraphTableDataOptions {
  // existing fields
  onProgress?: (progress: GraphTableLoadProgress) => void;
}
```

Immediately after `rows.push(...result.rows)`, emit accepted progress with a bounded loaded count:

```ts
options.onProgress?.({
  loadedRows: Math.min(rows.length, result.totalRows),
  totalRows: result.totalRows,
});
```

Do not emit before the post-response abort and generation checks.

- [ ] **Step 4: Run the direct test and verify GREEN**

Run:

```powershell
node --experimental-strip-types tests/loadGraphTableData.test.ts
```

Expected: `cancellable graph table loader passed`.

- [ ] **Step 5: Commit the loader contract**

```powershell
git add tests/loadGraphTableData.test.ts src/components/graphBuilder/loadGraphTableData.ts
git commit -m "feat(graph): report table loading progress"
```

---

### Task 2: Graph Builder Progress Presentation

**Files:**
- Modify: `tests/loadGraphTableData.test.ts`
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/components/graphBuilder/graphBuilder.css`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/vi.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`

**Interfaces:**
- Consumes: `onProgress(progress: GraphTableLoadProgress): void` from Task 1 and existing `graph.loading` translations.
- Produces: local `loadProgress: GraphTableLoadProgress | null`, localized `graph.loadingProgress` copy, and accessible determinate/indeterminate progress markup.

- [ ] **Step 1: Write failing source integration assertions**

Extend the existing `GraphBuilderView.tsx` source test to require reset, callback wiring, accessible progress markup, and localized detail:

```ts
assert.match(source, /setLoadProgress\(null\)/);
assert.match(source, /onProgress: setLoadProgress/);
assert.match(source, /role="progressbar"/);
assert.match(source, /aria-valuenow=/);
assert.match(source, /t\("graph\.loadingProgress"/);
```

Read all four locale JSON files and assert each has a non-empty
`graph.loadingProgress` string containing `{{loaded}}` and `{{total}}`.

- [ ] **Step 2: Run the direct test and verify RED**

Run:

```powershell
node --experimental-strip-types tests/loadGraphTableData.test.ts
```

Expected: assertion failure because the view does not yet wire or render progress.

- [ ] **Step 3: Add local progress state and callback wiring**

Import `GraphTableLoadProgress`, add local state, clear it at the beginning of every load, and pass the state setter to the loader:

```ts
const [loadProgress, setLoadProgress] = useState<GraphTableLoadProgress | null>(null);

setLoading(true);
setLoadProgress(null);
setError(null);

onProgress: setLoadProgress,
```

The loader already suppresses callbacks for aborted and invalid responses, so do not add a second progress source.

- [ ] **Step 4: Render accessible progress UI**

Replace the loading text-only placeholder with a vertical status. Use locale-aware number formatting and clamp percentage to `0..100`:

```ts
const loadPercent = loadProgress && loadProgress.totalRows > 0
  ? Math.min(100, Math.max(0, Math.round(
      (loadProgress.loadedRows / loadProgress.totalRows) * 100,
    )))
  : loadProgress?.totalRows === 0 ? 100 : null;
```

Render `.sp-progress-bar` with `role="progressbar"`. Set `aria-valuemin={0}` and `aria-valuemax={100}`; include `aria-valuenow={loadPercent}` only for determinate progress. Use `.sp-progress-indeterminate` before the first page and a width of `${loadPercent}%` afterward. Show `loadPercent%` and `t("graph.loadingProgress", { loaded, total })` only when progress is known.

- [ ] **Step 5: Add Graph Builder-local layout styles**

Add narrowly scoped classes without changing global progress styles:

```css
.gb-loading-status {
  width: min(320px, calc(100% - 32px));
  display: flex;
  flex-direction: column;
  gap: 8px;
  text-align: center;
}

.gb-loading-detail {
  color: var(--fg-muted);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 6: Add all four translations**

Under each locale's `graph` object, add:

```json
// en
"loadingProgress": "{{loaded}} / {{total}} rows"

// vi
"loadingProgress": "{{loaded}} / {{total}} hàng"

// zh-CN
"loadingProgress": "{{loaded}} / {{total}} 行"

// zh-TW
"loadingProgress": "{{loaded}} / {{total}} 列"
```

Keep each JSON file valid and preserve its established terminology.

- [ ] **Step 7: Run focused and build verification**

Run:

```powershell
node --experimental-strip-types tests/loadGraphTableData.test.ts
npx tsc -b
npx vite build
git diff --check
```

Expected: direct test prints its pass message; TypeScript and Vite exit `0`; diff check emits no errors.

- [ ] **Step 8: Commit the presentation**

```powershell
git add tests/loadGraphTableData.test.ts src/components/graphBuilder/GraphBuilderView.tsx src/components/graphBuilder/graphBuilder.css src/i18n/locales/en.json src/i18n/locales/vi.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json
git commit -m "feat(graph): show table loading progress"
```

- [ ] **Step 9: Run final verification**

Run the same direct test, `npx tsc -b`, `npx vite build`, and `git diff --check` after the commit. Confirm `git status --short --branch` contains no new implementation changes and do not push.