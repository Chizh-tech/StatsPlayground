# Fast Table Scroll Placeholder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Keep the spreadsheet grid visibly populated while a distant table window is loading after a fast scrollbar drag.

**Architecture:** A pure viewport helper decides whether the loaded window intersects the target render range and returns an inert placeholder range only when it does not. `DataTableView` renders placeholder rows with the existing virtual spacers; CSS preserves the table grid without exposing interactive cells.

**Tech Stack:** React 19, TypeScript 5.7, Tauri v2, DuckDB.

## Global Constraints

- Work only in `StatsPlayground-big-data-performance`.
- Do not commit or push.
- Do not increase the 500-row request size or 5,000-row cache cap.
- Never render stale row values at new logical row indices.

---

### Task 1: Placeholder Range Contract

**Files:**
- Modify: `src/utils/tableViewport.ts`
- Test: `tests/tableViewport.test.ts`

**Interfaces:**
- Produces: `calculatePlaceholderRange(viewportStart, viewportEnd, windowStart, windowRowCount)` returning `{ startIdx, endIdx } | null`.

- [ ] Add tests proving overlap returns `null`, a distant jump returns the target range, and an empty target returns `null`.
- [ ] Run `npx --yes tsx tests/tableViewport.test.ts` and verify RED because the helper is not exported.
- [ ] Implement the pure intersection helper.
- [ ] Rerun the test and verify GREEN.

### Task 2: Inert Grid Placeholder

**Files:**
- Modify: `src/components/DataTableView.tsx`
- Modify: `src/App.css`

**Interfaces:**
- Consumes: `calculatePlaceholderRange`.
- Produces: viewport-sized `.sp-placeholder-row` elements with target row numbers and noninteractive placeholder cells.

- [ ] Derive the placeholder range from `virtualRange`, `windowStart`, and `displayRows.length`.
- [ ] Render placeholders between virtual spacers only while no loaded rows intersect the target viewport.
- [ ] Style placeholder cells with existing theme variables and stable dimensions.
- [ ] Run `npm run build` and the cache/viewport regressions.

### Task 3: Visual Verification

**Files:**
- No source edits expected.

- [ ] Run the application from the performance worktree.
- [ ] Open the 300,000-row table and rapidly drag the vertical scrollbar.
- [ ] Confirm screenshots retain headers, row numbers, and grid pixels during loading.