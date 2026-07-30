# Surface Smoothing Design

## Goal

Surface plots show the observed grid as an unsmoothed faceted surface by default. A per-layer slider lets the user increase Z smoothing. The default and minimum value is `0`.

## User Experience

The Surface options panel keeps the existing Statistic selector and adds a Smoothness range control:

- Range: `0` to `1`
- Step: `0.05`
- Default: `0`
- `0`: render observed aggregated vertices without interpolation or smoothing
- Greater values: progressively smooth Z values while preserving X/Y locations and missing cells

The setting is stored in the Surface element's existing `options` object as `smoothness`, so it follows the current graph-project persistence path without a schema migration. Existing projects without this key use `0`.

## Surface Grid

`buildSurfaceData` derives sorted unique X and Y values from valid numeric rows. Their Cartesian layout defines the regular grid expected by echarts-gl:

1. Group rows by exact `(X, Y)` value.
2. Aggregate duplicate Z values with the selected mean or median statistic.
3. Emit vertices in Y-major, X-minor order.
4. Emit `[x, y, NaN]` for an unobserved `(X, Y)` combination.
5. Return `dataShape: [uniqueYCount, uniqueXCount]` with the vertices.

The Surface series passes `dataShape` explicitly. echarts-gl suppresses any quad containing an invalid vertex, so missing cells remain visible holes and the existing development warning about inferred data shape is removed.

A surface requires at least two unique X values, two unique Y values, and one complete quad. If no complete quad exists, that group does not emit a Surface series.

## Smoothing

Smoothing operates only on finite Z values after duplicate aggregation:

- X and Y coordinates never move.
- Missing cells remain missing at every slider value.
- Four Jacobi iterations replace each finite Z with a blend of its previous value and the mean of its finite orthogonal neighbors. Every vertex in an iteration reads from the same previous grid, so traversal order cannot affect the result.
- The clamped slider value is the neighbor-mean blend weight in every iteration: `nextZ = currentZ * (1 - smoothness) + neighborMean * smoothness`.
- At `0`, the smoothing pass is skipped exactly, so emitted finite Z values equal their aggregates.

Neighbor calculations use the unchanged missing-cell mask. Smoothing never bridges a hole by creating a new vertex.

## Rendering And Color

Existing grouped Surface behavior, mean/median aggregation, hidden groups, themed gradients, legends, and axis configuration remain unchanged. Gradient extrema are computed from the final finite Z values after smoothing.

## Localization

Add a Surface Smoothness label to English, Simplified Chinese, Traditional Chinese, and Vietnamese locale files, using the existing Graph Builder option-key structure.

## Validation

Focused regression coverage will verify:

- Missing `smoothness` behaves as `0`.
- At `0`, finite output Z values equal aggregated input values.
- Missing grid combinations emit NaN and remain holes.
- Explicit `dataShape` matches the sorted unique Y/X dimensions.
- Positive smoothing changes an interior finite Z value without filling missing cells.
- The frontend TypeScript/Vite build succeeds.
