---
name: graphcore-echarts
description: 'ECharts 6 chart-building knowledge for StatsPlayground graphCore, especially custom series and histogram bin math in src/graphCore/transform.ts. USE FOR: editing chart specs, custom renderItem series, histogram/shadowgram bins, boxplots, axis drag-zoom/pan behavior, bin-to-tick alignment, "bars invisible/blank chart", "bars drift off ticks", "bars breathe during drag", clip behavior. Keywords: ECharts, renderItem, custom series, api.coord, api.value, encode, clip, niceStep, bin grid, MODE A, MODE C, transform.ts, onAxisRangeChange. DO NOT USE FOR: generic ECharts questions unrelated to this repo, or non-chart StatsPlayground work (use statsplayground-dev).'
argument-hint: 'Describe the chart/graphCore change or bug (e.g. "histogram bars are 2 ticks wide after zoom")'
---

# graphCore / ECharts Deep Knowledge

Chart specs are assembled in
[src/graphCore/transform.ts](../../../src/graphCore/transform.ts) and rendered by
[src/graphCore/Graph.tsx](../../../src/graphCore/Graph.tsx). These rules encode
bugs that have cost multiple debugging round-trips — read before editing custom
series or bin math.

## When to Use
- Adding/editing any `type: "custom"` or `type: "boxplot"` series.
- Histogram / shadowgram bin computation (MODE A vertical, MODE C per-category).
- Anything touching axis drag-zoom/pan (`onAxisRangeChange`) and its interaction
  with chart data.

## Custom Series Rules
- **Return a single shape, not a group.** `{ type: "group", children: [...] }`
  with mixed child types (e.g. `circle` + `text`) silently fails to render even
  though `renderItem` fires. For multi-line labels use one `type: "text"` with
  `\n`-joined `style.text`; for per-segment color use rich text or one series per
  color.
- **Do NOT declare `encode`** on a custom series whose `renderItem` positions
  shapes via `api.coord(...)` / `params.coordSys`. Adding `encode` silently breaks
  rendering (stricter value-range validation). Pad the tuple with extra fields and
  read them via `api.value(i)` — that works WITHOUT `encode`.
- **`api.value(i)` is bounded by the max index in `encode`.** If you *do* use
  `encode`, dims above its max return NaN/undefined. Prefer a closure-bound array
  indexed by `params.dataIndex` for non-axis fields; put only axis coords in the
  tuple. This also survives transpose pipelines that flip tuple order.
- **`api.value(catDim)` on a categorical axis returns the ORDINAL index**, not the
  string label. (This one caused ~a day of "blank chart, no errors".)
- **Always set `clip: true`** on custom and boxplot series. `series-custom.clip`
  defaults to `false`; `series-boxplot.clip` needs **echarts ≥ 6.1.0** (keep it
  pinned in package.json). Do NOT also clip the rect inside `renderItem` — that
  resizes/shifts the bar and makes it "jump" during drag. Return the full unclipped
  shape and let `clip: true` mask it.

## Histogram Bin Math (MODE A & MODE C)
The axis supports drag-zoom/pan; `onAxisRangeChange` writes `{min,max}` into
`spec.xAxis`/`spec.yAxis`. Bins must stay aligned to the axis minor ticks through
all of this.

- **Respect user-pinned bounds.** After scanning data for `lo`/`hi`, override with
  the pinned side(s):
  ```ts
  const lo = Number.isFinite(userPinMin) ? userPinMin : autoLo; // RAW pin
  const hi = Number.isFinite(userPinMax) ? userPinMax : autoHi; // RAW pin
  ```
  One-sided pins are valid. Do **not** re-run pins through
  `computeNiceBounds(...)` — that snaps them to a coarser local nice value and
  makes bin width 2× the axis minor tick.
- **Mirror the axis emission exactly.** Axis bounds = `{ min: user.min ?? fit.min,
  max: user.max ?? fit.max }` where `fit = computeNiceBounds(dataMin, dataMax,
  refs, AUTO_TARGET_TICKS=10)`. Bins must do the identical merge.
- **binWidth = niceStep(hi-lo, BIN_GRID_TARGET_TICKS=5) / minorSplit — never
  re-derive.** Anti-pattern `width = span / round(span/binWidth)` drifts bars off
  ticks the further right you go. Derive `binCount` from the snapped grid instead.
- **`niceStep` ladder MUST match ECharts exactly**: ladder `{1,2,3,5,10}` with
  breakpoints `{1.5,2.5,4,7}` (from `echarts/src/scale/helper.ts` `nice()`). A
  different ladder (e.g. `{1,2,2.5,5,10}`) makes bars align at some zooms but not
  others — suspect ladder mismatch FIRST.
- **Snap grid origin to nice multiples of binWidth**:
  `gridOrigin = Math.floor(lo / width) * width` (not raw `lo`).
- **Over-render past the visible range.** The drag pipeline sends only axis updates
  (`setOption({xAxis,yAxis}, {lazyUpdate:true, silent:true})`), never new data, so
  bins outside `[lo,hi]` at build time never appear until pointerup. Extend the bin
  grid to the full data extent with the same width and rely on `clip: true`:
  ```ts
  const extLo = Math.min(lo, dataLo), extHi = Math.max(hi, dataHi);
  gridOrigin = Math.floor(extLo / width) * width;
  const gridEnd = Math.ceil(extHi / width) * width;
  binCount = Math.max(1, Math.round((gridEnd - gridOrigin) / width));
  ```
- **MODE C per-cat normalization uses ALL-data max, not visible max.** Normalize
  each cat slot by its peak across the WHOLE dataset; otherwise the histogram
  "breathes" as the tallest bin scrolls off-screen during a pan.
- **Faceted shared-range mode**: recompute `yMajorStep = niceStep(yHi-yLo,
  BIN_GRID_TARGET_TICKS)` — do NOT trust `sharedRanges.yInterval` (computed with
  `AUTO_TARGET_TICKS=10`, ~2× too fine → half-tick offsets). Shared range already
  covers all panels, so no extra over-render extension is needed.

Relevant constants: `AUTO_TARGET_TICKS=10`, `BIN_GRID_TARGET_TICKS=5`,
`AUTO_MINOR_SPLIT=5`. There are 5 custom series + 1 boxplot in transform.ts
(`__ci`, band-ref carrier, 3× `__hist_cat_*`); add `clip: true` to any new one.

## Debugging Heuristics
- "Bars invisible but labels render" → NaN width from `api.value(i)` past encode
  max, or a group-with-children return.
- "Blank chart, no console error" → group-with-children, or `encode` added to an
  `api.coord`-positioned custom series, or categorical ordinal vs string confusion.
- "Bars drift off ticks at some zooms" → `niceStep` ladder mismatch (check first).
- "Bars 2 ticks wide after drag" → pins pushed through `computeNiceBounds`.
- "Empty band revealed on outward drag until release" → bins not over-rendered.
- "Histogram breathes during pan" → per-cat max using visible instead of all data.
