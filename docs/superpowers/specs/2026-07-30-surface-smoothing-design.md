# Surface Visual Smoothing Design

## Goal

Surface plots retain their observed X/Y/Z geometry at every smoothing setting. A per-layer slider reduces the visual prominence of facets through lighting only. The default and minimum value is `0`.

## User Experience

The Surface options panel keeps the existing Statistic selector and adds a Smoothness range control:

- Range: `0` to `1`
- Step: `0.05`
- Default: `0`
- `0`: strong directional lighting keeps surface relief and facet contrast visible
- Greater values: progressively soften facet contrast without changing any vertex

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

## Visual Smoothing

The previous four-pass Jacobi Z smoothing is removed. It changed peaks, valleys, and therefore the shape represented by the data.

All Surface series use Lambert shading. echarts-gl computes averaged vertex normals from the unchanged mesh, producing continuous light response across adjacent triangles. The clamped slider value `s` only controls the global `grid3D.light` balance:

- `main.intensity = 1.2 - 0.9 * s`
- `ambient.intensity = 0.3 + 0.6 * s`

At `s = 0`, the existing main and ambient intensities remain `1.2` and `0.3`. At `s = 1`, they become `0.3` and `0.9`, reducing directional-light contrast while retaining enough main light for depth perception.

The slider never participates in grid construction or aggregation. X, Y, Z, missing-cell NaNs, data shape, extrema, and gradient ranges are bit-for-bit identical across slider values.

## Rendering And Color

Existing grouped Surface behavior, mean/median aggregation, hidden groups, themed gradients, legends, and axis configuration remain unchanged. Lambert shading continues to use each vertex's visualMap color, so the themed Z gradient remains visible while lighting supplies the softened surface relief.

`grid3D.light` is shared by the scene, which is appropriate because Graph Builder supports one Surface layer whose grouped series share the same options. Scatter-only scenes keep the existing default lighting values.

## Localization

Add a Surface Smoothness label to English, Simplified Chinese, Traditional Chinese, and Vietnamese locale files, using the existing Graph Builder option-key structure.

## Validation

Focused regression coverage will verify:

- Missing `smoothness` behaves as `0`.
- Surface vertex data is deeply equal at `smoothness = 0` and a positive value.
- Missing grid combinations remain NaN holes at every value.
- Every Surface series uses Lambert shading while preserving visualMap-based Z colors.
- `smoothness = 0` emits main/ambient intensities `1.2` and `0.3`.
- `smoothness = 1` emits main/ambient intensities `0.3` and `0.9`.
- The frontend TypeScript/Vite build succeeds.
