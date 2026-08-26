# Scatter Progressive Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make raw Full Data scatter points appear in one render pass instead of ECharts progressive batches.

**Architecture:** Keep the existing global no-animation render-boundary policy and add the independent `progressive: 0` policy directly to raw scatter series in `transform.ts`. Verify the real `buildGraph` output so per-point metadata and interaction behavior remain intact; do not enable ECharts large mode.

**Tech Stack:** TypeScript 5.7, ECharts 5.6, direct Node TypeScript tests, Vite 6.

## Global Constraints

- Apply `progressive: 0` only to raw `points` scatter series.
- Preserve Full Data, `_row_id`/`__pick` metadata, symbol offsets, styles, and point-click behavior.
- Keep ECharts `large` mode disabled.
- Do not change summary dots, boxplot outliers, synthetic scatter overlays, 3D charts, or global animation handling.
- Do not add dependencies or backend changes.

---

### Task 1: Disable Raw Scatter Progressive Rendering

**Files:**
- Create: `tests/scatterProgressive.test.ts`
- Modify: `src/graphCore/transform.ts`

**Interfaces:**
- Consumes: `buildGraph(spec, data, theme)` and existing raw point-series construction.
- Produces: raw scatter options with `progressive: 0` and unchanged per-point `__pick` metadata.

- [ ] **Step 1: Write the failing behavior test**

Create a direct Node test that stubs `localStorage`, dynamically imports
`buildGraph`, and builds an unaggregated points chart from data containing
`_row_id`, `x`, and `y`:

```ts
const spec: GraphSpec = {
  encoding: {
    x: { name: "x", type: "continuous" },
    y: { name: "y", type: "continuous" },
  },
  elements: [{ kind: "points", options: { summaryStat: "none", jitter: "none" } }],
};

const data: GraphData = {
  columns: ["_row_id", "x", "y"],
  rows: [[42, 1, 2], [43, 2, 3]],
};
```

Find the raw scatter in `result.panels[0].option.series` and assert:

```ts
assert.equal(scatter.progressive, 0);
assert.notEqual(scatter.large, true);
assert.deepEqual((scatter.data as any[])[0].__pick, {
  rowId: 42,
  colName: "y",
});
```

- [ ] **Step 2: Run the test and verify RED**

Run:

```powershell
node --experimental-strip-types tests/scatterProgressive.test.ts
```

Expected: assertion failure because the raw scatter's `progressive` property is
currently `undefined` rather than `0`.

- [ ] **Step 3: Add the minimal raw-scatter policy**

In the raw scatter object returned by the `points` element's non-aggregated
branch, add:

```ts
progressive: 0,
```

Do not add `large`, `progressiveThreshold`, or global option changes.

- [ ] **Step 4: Run focused and full frontend verification**

Run:

```powershell
node --experimental-strip-types tests/scatterProgressive.test.ts
node --experimental-strip-types tests/graphAnimation.test.ts
node --experimental-strip-types tests/graphTableDataCache.test.ts
node --experimental-strip-types tests/loadGraphTableData.test.ts
npx tsc -b
npx vite build
git diff --check
```

Expected: all direct tests print pass messages; TypeScript, Vite, and diff check
exit `0`.

- [ ] **Step 5: Commit the fix**

```powershell
git add tests/scatterProgressive.test.ts src/graphCore/transform.ts
git commit -m "fix(graph): render scatter points in one pass"
```