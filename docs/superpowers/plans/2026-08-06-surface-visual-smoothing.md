# Surface Visual Smoothing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Surface smoothness slider soften facet lighting without changing any Surface vertex or statistical value.

**Architecture:** Remove `smoothness` from observed-grid construction and always emit the exact aggregated X/Y/Z grid. Render Surface series with Lambert shading so echarts-gl generates averaged vertex normals, then map the clamped slider value to the shared `grid3D` main/ambient light intensities. Scatter-only scenes retain the existing light defaults.

**Tech Stack:** TypeScript, ECharts 5.6, echarts-gl 2.0.9, Node assert regression test, Vite 6.

## Global Constraints

- Surface slider range remains `0..1`, step `0.05`, default `0`.
- X, Y, Z, NaN holes, `dataShape`, extrema, and visualMap ranges must be identical at every slider value.
- Surface series use Lambert shading and preserve visualMap vertex colors.
- Light mapping is `main = 1.2 - 0.9s`, `ambient = 0.3 + 0.6s`.
- Scatter-only scenes keep main/ambient intensities `1.2` and `0.3`.
- Do not modify or commit unrelated workspace changes.

---

### Task 1: Replace Geometry Smoothing With Visual Lighting

**Files:**
- Modify: `tests/threeD.test.ts`
- Modify: `src/graphCore/threeD.ts`

**Interfaces:**
- Consumes: `build3DOption(spec: GraphSpec, data: GraphData, theme: GraphTheme): Build3DResult` and Surface element option `smoothness`.
- Produces: unchanged Surface `series.data`, Lambert `series.shading`, and mapped `grid3D.light.main.intensity` / `grid3D.light.ambient.intensity`.

- [ ] **Step 1: Replace the old smoothing assertion with visual-only requirements**

In `tests/threeD.test.ts`, build the same Surface fixture at omitted smoothness and at `smoothness: 1`. Assert the Surface data arrays are deeply equal, the hole remains NaN, both series use `shading: "lambert"`, and the two options emit light intensities `(1.2, 0.3)` and `(0.3, 0.9)` respectively:

```ts
const smoothSurface = buildSurface(1);
assert.ok(smoothSurface.option);
const smoothSeries = (smoothSurface.option.series as Array<Record<string, unknown>>)
  .find((item) => item.type === "surface");
assert.ok(smoothSeries);
assert.deepEqual(smoothSeries.data, rawSeries.data);
assert.equal(rawSeries.shading, "lambert");
assert.equal(smoothSeries.shading, "lambert");

const rawLight = (rawSurface.option.grid3D as {
  light: { main: { intensity: number }; ambient: { intensity: number } };
}).light;
const smoothLight = (smoothSurface.option.grid3D as {
  light: { main: { intensity: number }; ambient: { intensity: number } };
}).light;
assert.equal(rawLight.main.intensity, 1.2);
assert.equal(rawLight.ambient.intensity, 0.3);
assert.equal(smoothLight.main.intensity, 0.3);
assert.equal(smoothLight.ambient.intensity, 0.9);
```

- [ ] **Step 2: Run the focused regression and verify RED**

Run:

```powershell
npx esbuild tests/threeD.test.ts --bundle --platform=node --format=esm --alias:@=./src --outfile=node_modules/.tmp/threeD.test.mjs
node node_modules/.tmp/threeD.test.mjs
```

Expected: FAIL because positive smoothness currently changes Surface Z values, Surface shading is `color`, and lighting is constant.

- [ ] **Step 3: Remove smoothing from grid construction**

In `src/graphCore/threeD.ts`, remove the `smoothness` parameter and the four-pass Jacobi block from `buildSurfaceData`. Keep the aggregated `Float64Array` unchanged through vertex emission:

```ts
function buildSurfaceData(
  data: GraphData,
  xName: string,
  yName: string,
  zName: string,
  stat: SurfaceStat,
): { verts: number[][]; dataShape: [number, number]; zmin: number; zmax: number } | null {
```

Update its call site to pass only `gdata`, field names, and `stat`.

- [ ] **Step 4: Clamp visual smoothness and track emitted Surface series**

Normalize the element option once and track whether `addLayers` emits at least one Surface:

```ts
const rawSurfaceSmoothness = Number(surfaceEl?.options?.smoothness ?? 0);
const surfaceSmoothness = Number.isFinite(rawSurfaceSmoothness)
  ? Math.max(0, Math.min(1, rawSurfaceSmoothness))
  : 0;
let hasSurfaceSeries = false;
```

Set `hasSurfaceSeries = true` when a Surface series is pushed. This prevents an invalid/empty Surface layer from changing a scatter-only scene's lighting.

- [ ] **Step 5: Use Lambert shading and map lighting only**

Set every emitted Surface series to `shading: "lambert"`. Remove the obsolete `surfIndices` fallback because all Surface series now use Lambert unconditionally. Before constructing `option`, derive scene softness:

```ts
const visualSmoothness = hasSurfaceSeries ? surfaceSmoothness : 0;
const mainIntensity = 1.2 - 0.9 * visualSmoothness;
const ambientIntensity = 0.3 + 0.6 * visualSmoothness;
```

Use these values in `grid3D.light.main.intensity` and `grid3D.light.ambient.intensity`. Keep the existing visualMap `seriesIndex`, dimension, extrema, and color arrays unchanged.

- [ ] **Step 6: Run the focused regression and verify GREEN**

Run the Step 2 commands again.

Expected: `threeD regressions passed` with exit code 0.

- [ ] **Step 7: Run diagnostics and the frontend build**

Check VS Code diagnostics for both modified files, then run:

```powershell
npx vite build
```

Expected: no diagnostics and Vite exits 0. The existing large-chunk warning is acceptable.

- [ ] **Step 8: Review and commit only scoped files**

Inspect `git diff` and verify no UI, locale, dependency, or unrelated files are included. Commit:

```powershell
git add -- src/graphCore/threeD.ts tests/threeD.test.ts docs/superpowers/plans/2026-08-06-surface-visual-smoothing.md
git commit -m "fix(graph): preserve surface geometry when smoothing"
```

Do not push.
