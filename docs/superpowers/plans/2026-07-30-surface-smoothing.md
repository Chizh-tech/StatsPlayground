# Surface Smoothing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render Surface plots as unsmoothed observed grids by default and add a per-layer `0..1` Z-smoothing slider that preserves missing-cell holes.

**Architecture:** Replace the fixed 48x48 IDW grid in `threeD.ts` with a sorted unique X/Y grid containing aggregated finite Z values or NaN holes. Apply four masked Jacobi passes only when `smoothness > 0`, return explicit `dataShape`, and expose the option through the existing Surface layer editor and persistence path.

**Tech Stack:** React 19, TypeScript, ECharts 5.6, echarts-gl 2.0.9, Node assert regression test, Vite.

---

### Task 1: Observed Surface Grid And Masked Smoothing

**Files:**
- Modify: `tests/threeD.test.ts`
- Modify: `src/graphCore/threeD.ts`

- [x] **Step 1: Write the failing grid regression assertions**

Add Surface fixtures that assert an omitted option behaves as `smoothness: 0`, duplicate `(X,Y)` values aggregate correctly, missing combinations emit NaN, `dataShape` is `[uniqueYCount, uniqueXCount]`, and positive smoothing changes finite Z values without filling the hole.

- [x] **Step 2: Run the focused test and verify RED**

Run:

```powershell
npx esbuild tests/threeD.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=node_modules/.tmp/threeD.test.mjs
node node_modules/.tmp/threeD.test.mjs
```

Expected: assertion failure because the current 48x48 IDW result has no explicit `dataShape` and fills every cell.

- [x] **Step 3: Implement the observed grid**

Change `buildSurfaceData` to accept `smoothness`, derive sorted unique X/Y coordinates, aggregate duplicate Z values, emit NaN holes in Y-major/X-minor order, validate at least one complete quad, and return `{ verts, dataShape, zmin, zmax }`.

- [x] **Step 4: Implement deterministic masked smoothing**

Clamp `smoothness` to `0..1`; skip exactly at zero. Otherwise run four Jacobi passes using finite orthogonal neighbors and preserve the original finite/missing mask.

- [x] **Step 5: Pass the option and shape to echarts-gl**

Read `surfaceEl.options.smoothness` with a zero fallback, pass it into `buildSurfaceData`, and set `dataShape: s.dataShape` on each Surface series.

- [x] **Step 6: Run the focused test and verify GREEN**

Run the Step 2 commands. Expected: `threeD regressions passed` and exit code 0.

### Task 2: Surface Smoothness Control

**Files:**
- Modify: `src/components/graphBuilder/GraphBuilderView.tsx`
- Modify: `src/i18n/locales/en.json`
- Modify: `src/i18n/locales/zh-CN.json`
- Modify: `src/i18n/locales/zh-TW.json`
- Modify: `src/i18n/locales/vi.json`

- [x] **Step 1: Default new Surface layers to zero**

Set new Surface options to `{ stat: "mean", smoothness: 0 }`; old projects remain compatible because the editor and renderer both fall back to zero.

- [x] **Step 2: Add the slider to SurfaceOptions**

Read `smoothness` with `getOpt<number>(options, "smoothness", 0)` and render the existing `gb-slider` range input with `min={0}`, `max={1}`, `step={0.05}`, and `onChange({ smoothness: parseFloat(e.target.value) })`.

- [x] **Step 3: Add locale labels**

Add `graph.opt.surfaceSmoothness` in all four locale files: `Smoothness`, `平滑程度`, `平滑程度`, and `Độ mịn bề mặt`.

- [x] **Step 4: Check edited-file diagnostics**

Run VS Code diagnostics for the component, renderer, test, and locale files. Expected: no errors.

### Task 3: Verification And Commit

**Files:**
- Verify all files from Tasks 1-2

- [x] **Step 1: Run focused regression test**

Run the Task 1 command. Expected: exit code 0.

- [x] **Step 2: Run frontend production build**

Run:

```powershell
npx vite build
```

Expected: `built in` with exit code 0; the existing large-chunk warning is acceptable.

- [x] **Step 3: Inspect the scoped diff**

Confirm only Surface grid/smoothing, its control/localization, the regression test, and this plan changed. Preserve unrelated untracked files.

- [x] **Step 4: Commit the implementation**

```powershell
git add -- src/graphCore/threeD.ts src/components/graphBuilder/GraphBuilderView.tsx src/i18n/locales/en.json src/i18n/locales/zh-CN.json src/i18n/locales/zh-TW.json src/i18n/locales/vi.json tests/threeD.test.ts docs/superpowers/plans/2026-07-30-surface-smoothing.md
git commit -m "feat(graph): add adjustable surface smoothing"
```

Do not push.
