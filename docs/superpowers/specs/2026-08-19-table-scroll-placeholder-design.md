# Fast Table Scroll Placeholder Design

## Problem

Dragging the vertical scrollbar across a large table can move the viewport far
outside the currently loaded 500-row window. Until the new DuckDB window
arrives, the renderer has no intersecting rows and paints only the dark table
background.

## Design

When the requested viewport and loaded window do not overlap, render one
viewport-sized set of inert placeholder rows at the target logical indices.
Placeholders preserve row numbers, column widths, grid lines, and scroll
geometry without displaying stale values. They disappear atomically when the
target window is applied.

The backend window size, 5,000-row cache limit, request epoch behavior, and IPC
contract remain unchanged.

## Verification

- Pure viewport tests cover overlap, distant jumps, and end-of-table clamping.
- Frontend build and existing cache/viewport regressions must pass.
- A 300,000-row table is checked by rapidly dragging the scrollbar and
  confirming the grid never becomes a blank background.